require("dotenv").config();
const { Octokit } = require("@octokit/rest");
const { createClient } = require("@supabase/supabase-js");

const octokit = new Octokit({
  auth: process.env.GIT_TOKEN,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const allowedLicenses = ["mit", "apache-2.0", "bsd-3-clause"];

async function ingestRepos() {
  console.log("📥 Fetching repositories from GitHub...");
async function searchPopularRepos() {
  const allRepos = [];

for (let page = 1; page <= 10; page++) {
  const { data } = await octokit.rest.search.repos({
    q: "stars:>=500 created:>=2025-01-01 archived:false fork:false",
    sort: "stars",
    order: "desc",
    per_page: 100,
    page,
  });

  allRepos.push(...data.items);
}

return allRepos
}
let allRepos=await searchPopularRepos()
 

  console.log(`🔎 Total fetched: ${allRepos.length}`);

  const filtered = allRepos.filter(repo =>
    allowedLicenses.includes(repo.license?.key)
  );
console.log(`🔎 Total filtered repos with license: ${filtered.length}`);
  const formatted = filtered.map(repo => ({
    id: repo.id,
    owner: repo.owner.login,
    repo_name: repo.name,
    repo_html_url: repo.html_url,
    stars: repo.stargazers_count,
    licensed: repo.license?.key || null,
  }));

  const { error } = await supabase
    .from("repos")
    .upsert(formatted, { onConflict: "id" });

  if (error) throw error;

  console.log(`✅ ${formatted.length} repos stored in DB`);
}





async function run() {
  try {
    console.log("🚀 Ingest Pipeline Started\n");

    await ingestRepos();
    // await processRepos();

    console.log("\n🎉  Ingest Pipeline Completed");
  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

run();