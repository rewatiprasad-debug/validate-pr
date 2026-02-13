require("dotenv").config();
const { Octokit } = require("@octokit/rest");
const { createClient } = require("@supabase/supabase-js");

// -------------------
// CONFIG
// -------------------

const octokit = new Octokit({
    auth: process.env.GIT_TOKEN,
});

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

const allowedLicenses = ["mit", "apache-2.0", "bsd-3-clause"];

// ======================================================
// 1️⃣ INGEST REPOSITORIES (GitHub → DB)
// ======================================================

async function ingestRepos() {
    console.log("📥 Fetching repositories from GitHub...");

    async function searchPopularRepos() {
        const allRepos = [];

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

            for (let page = 1; page <= 5; page++) {
                const { data } = await octokit.rest.search.repos({
                    q: `stars:>=5000 created:>=2023-01-01 archived:false fork:false language:"${language}"`,
                    sort: "stars",
                    order: "desc",
                    per_page: 100,
                    page,
                });

                allRepos.push(...data.items);

                // Stop early if fewer than 100 results returned
                if (data.items.length < 100) break;

                // Small delay to avoid abuse detection
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
        }

        // Remove duplicates (repos can sometimes overlap)
        const uniqueRepos = Array.from(
            new Map(allRepos.map(repo => [repo.id, repo])).values()
        );

        return uniqueRepos;
    }


    let allRepos = await searchPopularRepos()


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


// ======================================================
// 2️⃣ FETCH UNPROCESSED REPOS FROM DB
// ======================================================

async function fetchPendingRepos(limit = 100) {
    const { data, error } = await supabase
        .from("repos")
        .select("*")
        .is("processed", null)
        .limit(limit);

    if (error) throw error;

    return data;
}

// ======================================================
// 3️⃣ SEARCH PRs
// ======================================================

async function searchPRs(owner, repo) {
    const { data } = await octokit.rest.search.issuesAndPullRequests({
        q: `repo:${owner}/${repo} is:pr is:merged`,
        sort: "updated",
        order: "desc",
        per_page: 10,
    });

    return data.items;
}

// ======================================================
// 4️⃣ VALIDATE PR (YOUR ORIGINAL LOGIC)
// ======================================================

async function validatePR(owner, repo, pull_number) {
    const pr = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
    });

    const totalChanges = pr.data.additions + pr.data.deletions;

    if (totalChanges < 500) return null;
    if (pr.data.changed_files < 5) return null;

    const files = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number,
    });

    const hasTests = files.data.some(file =>
        file.filename.toLowerCase().includes("test") ||
        file.filename.toLowerCase().includes("spec")
    );

    if (!hasTests) return null;

    const status = await octokit.rest.repos.getCombinedStatusForRef({
        owner,
        repo,
        ref: pr.data.head.sha,
    });

    if (status.data.state !== "success") return null;

    return {
        id: pr.data.id,
        pr_number: pr.data.number,
        pr_html_url: pr.data.html_url,
        additions: pr.data.additions,
        deletions: pr.data.deletions,
        changed_files: pr.data.changed_files,
    };
}

// ======================================================
// 5️⃣ PROCESS REPOS (DB → VALIDATE → STORE PRs)
// ======================================================

async function processRepos() {
    const repos = await fetchPendingRepos(50);
    console.log(`fetched pending repo : ${repos.length}`)
    for (const repo of repos) {
        console.log(`🔍 Processing ${repo.owner}/${repo.repo_name}`);

        const prs = await searchPRs(repo.owner, repo.repo_name);

        for (const pr of prs) {
            const validPR = await validatePR(
                repo.owner,
                repo.repo_name,
                pr.number
            );

            if (validPR) {
                console.log("✅ Valid PR found:", validPR.pr_html_url);

                await supabase.from("pull_requests").upsert(
                    {
                        ...validPR,
                        repo_id: repo.id,
                    },
                    { onConflict: "id" }
                );
            }
        }

        // mark repo as processed after checking all PRs
        await supabase
            .from("repos")
            .update({ processed: true })
            .eq("id", repo.id);

        console.log(`✔ Repo ${repo.repo_name} marked processed`);
    }
}

// ======================================================
// 6️⃣ MAIN CONTROLLER
// ======================================================

async function run() {
    try {
        console.log("🚀 Pipeline Started\n");

        await ingestRepos();
        await processRepos();

        console.log("\n🎉 Pipeline Completed");
    } catch (err) {
        console.error("❌ Error:", err.message);
    }
}

run();
