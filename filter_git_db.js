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

const allowedLicenses = ["mit", "apache-2.0", "bsd-2-clause", "bsd-3-clause",
    "isc", "unlicense", "0bsd", "artistic-2.0",
    "zlib", "wtfpl", "cc0-1.0", "mpl-2.0",];

// ======================================================
// 1️⃣ INGEST REPOSITORIES (GitHub → DB)
// ======================================================


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
                q: `stars:>=1000 created:>=2023-01-01 archived:false fork:false language:"${language}"`,
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
