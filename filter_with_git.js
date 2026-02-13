const {Octokit}=require('@octokit/rest')
const fs = require("fs").promises;
const path = require("path");
require('dotenv').config();
const { appendFile } = require("fs/promises");

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});
let finalResult=[]

async function searchPopularRepos() {
  const allRepos = [];

for (let page = 1; page <= 10; page++) {
  const { data } = await octokit.rest.search.repos({
    q: "stars:>=4000 archived:false fork:false",
    sort: "stars",
    order: "desc",
    per_page: 100,
    page,
  });

  allRepos.push(...data.items);
}

return allRepos
}

const allowedLicenses = ["mit", "apache-2.0", "bsd-3-clause"];

function filterPermissiveRepos(repos) {
  return repos.filter(repo =>
    allowedLicenses.includes(repo.license?.key)
  );
}

async function searchPRs(owner, repo) {
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:pr is:merged`,
    sort: "updated",
    order: "desc",
    per_page: 10,
  });

  return data.items;
}

async function validatePR(owner, repo, pull_number) {
  const pr = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number,
  });

  const totalChanges = pr.data.additions + pr.data.deletions;

  if (totalChanges < 500) return false;
  if (pr.data.changed_files < 5) return false;

  const files = await octokit.rest.pulls.listFiles({
    owner,
    repo,
    pull_number,
  });

  const hasTests = files.data.some(file =>
    file.filename.toLowerCase().includes("test") ||
    file.filename.toLowerCase().includes("spec")
  );

  if (!hasTests) return false;

  const status = await octokit.rest.repos.getCombinedStatusForRef({
    owner,
    repo,
    ref: pr.data.head.sha,
  });

  if (status.data.state !== "success") return false;

  return true;
}

// function saveResultsToJSON(data, filename = "results.json") {
//   try {
//     // Convert array to JSON string with indentation
//     const jsonContent = JSON.stringify(data, null, 2);

//     // Resolve path relative to current directory
//     const filePath = path.resolve(__dirname, filename);

//     // Write file
//     fs.writeFileSync(filePath, jsonContent, "utf8");

//     console.log(`✅ Results saved to ${filePath}`);
//   } catch (error) {
//     console.error("❌ Error writing JSON file:", error);
//   }
// }
async function saveResultsToTXT(newData, filename = "results.txt") {
  try {
    const filePath = path.resolve(__dirname, filename);

    // Ensure it's always an array
    if (!Array.isArray(newData)) {
      newData = [newData];
    }

    // Format each URL like: "url",
    const formattedData =
      newData.map(url => `"${url}",`).join("\n") + "\n";

    // Append to file (does NOT overwrite)
    await appendFile(filePath, formattedData, "utf8");

    console.log(`✅ Data appended to ${filePath}`);
  } catch (error) {
    console.error("❌ Error writing TXT file:", error);
  }
}

async function appendToFile(data_string) {
  try {
    await fs.appendFile('example.txt', data_string+','+'\n', 'utf8');
    console.log('Content appended successfully');
  } catch (err) {
    console.error('Error appending to file:', err);
  }
}


async function runPipeline() {
    console.log("process start........")
  const repos = await searchPopularRepos();
  console.log(`fetching total no of repos : ${repos.length}`)
  
  const filteredRepos = filterPermissiveRepos(repos);

  console.log(`total no of repo after filtering with mit License : ${filteredRepos.length}`)


  for (const repo of filteredRepos) {
    console.log(`Checking repo: ${repo.full_name}`);

    const prs = await searchPRs(repo.owner.login, repo.name);

    for (const pr of prs) {
      const isValid = await validatePR(
        repo.owner.login,
        repo.name,
        pr.number
      );

      if (isValid) {
        console.log("✅ Valid PR found:", pr.html_url);
        appendToFile(String(pr.html_url))

        

      }
    }
  }
        // saveResultsToTXT(finalResult, "validPRs.txt")
}

runPipeline()



