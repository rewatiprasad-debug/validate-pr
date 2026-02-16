require("dotenv").config();
const { Octokit } = require("@octokit/rest");
const { createClient } = require("@supabase/supabase-js");

const octokit = new Octokit({
  auth: process.env.GIT_TOKEN,
});

const authenticatedUser = async () => {
  const { data: user } = await octokit.rest.users.getAuthenticated();
  console.log("Authenticated as:", user.login);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const allowedLicenses = ["mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause",
    "isc", "unlicense", "0bsd", "artistic-2.0",
    "zlib", "wtfpl", "cc0-1.0", "mpl-2.0",];


async function ingestRepos() {
    console.log("📥 Fetching repositories from GitHub...");

async function searchPopularRepos() {
    const PER_LANGUAGE_COUNT = 100;
    const globalRepoMap = new Map(); // avoid cross-language duplicates

    const languages = [
        "Python",
        "JavaScript",
        "TypeScript",
        "Java",
        "Go",
        "Rust",
        "C++",
        "C"
    ];

    for (const language of languages) {
        console.log(`🔎 Fetching ${language} repos...`);

        let page = 1;
        const languageRepoMap = new Map(); // track per-language count

        while (languageRepoMap.size < PER_LANGUAGE_COUNT) {
            const { data } = await octokit.rest.search.repos({
                q: `stars:>=1000 created:>=2022-01-01 archived:false fork:false language:"${language}"`,
                sort: "stars",
                order: "desc",
                per_page: 100,
                page,
            });

            if (!data.items.length) break;

            for (const repo of data.items) {

                // Avoid duplicates across languages
                if (!globalRepoMap.has(repo.id)) {
                    globalRepoMap.set(repo.id, repo);
                    languageRepoMap.set(repo.id, repo);
                }

                if (languageRepoMap.size >= PER_LANGUAGE_COUNT) {
                    console.log(`✅ ${language} reached ${PER_LANGUAGE_COUNT}`);
                    break;
                }
            }

            console.log(
                `   ${language} Page ${page} — Collected: ${languageRepoMap.size}`
            );

            if (data.items.length < 100) break;
            if (languageRepoMap.size >= PER_LANGUAGE_COUNT) break;

            page++;
            await new Promise(resolve => setTimeout(resolve, 1200));
        }
    }

    console.log(`🎯 Total collected across languages: ${globalRepoMap.size}`);

    return Array.from(globalRepoMap.values());
}


    const allRepos = await searchPopularRepos();
    console.log(`🔎 Total unique fetched: ${allRepos.length}`);

    const filtered = allRepos.filter(repo =>
        allowedLicenses.includes(repo.license?.key)
    );

    console.log(`🔎 Total filtered repos with allowed license: ${filtered.length}`);

    const formatted = filtered.map(repo => ({
        id: repo.id,
        owner: repo.owner.login,
        repo_name: repo.name,
        repo_html_url: repo.html_url,
        stars: repo.stargazers_count,
        licensed: repo.license?.key || null,
    }));

    // 🔥 Insert only new repos & get exact inserted count
    const { data: insertedCount, error } = await supabase.rpc("insert_repos", {
        _repos: formatted
    });

    if (error) throw error;

    console.log(`🆕 Newly inserted repos: ${insertedCount}`);
    console.log("✅ Ingestion complete");
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
