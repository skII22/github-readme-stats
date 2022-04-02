// @ts-check
const githubUsernameRegex = require("github-username-regex");

const retryer = require("../common/retryer");
const calculateRank = require("../calculateRank");
const {
  request,
  logger,
  CustomError,
  MissingParamError,
} = require("../common/utils");

require("dotenv").config();

/**
 * @param {import('axios').AxiosRequestHeaders} variables
 * @param {string} token
 */
const fetcher = (variables, token) => {
  return request(
    {
      query: `
      query userInfo($login: String!) {
        user(login: $login) {
          name
          login
          contributionsCollection {
            totalCommitContributions
            restrictedContributionsCount
            contributionYears
          }
          repositoriesContributedTo(first: 1, contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) {
            totalCount
          }
          pullRequests(first: 1) {
            totalCount
          }
          openIssues: issues(states: OPEN) {
            totalCount
          }
          closedIssues: issues(states: CLOSED) {
            totalCount
          }
          followers {
            totalCount
          }
          repositories(first: 100, ownerAffiliations: OWNER, orderBy: {direction: DESC, field: STARGAZERS}) {
            totalCount
            nodes {
              stargazers {
                totalCount
              }
            }
          }
        }
      }
      `,
      variables,
    },
    {
      Authorization: `bearer ${token}`,
    },
  );
};

const fetchYearCommits = (variables, token) => {
  return request({
    query: `
      query userInfo($login: String!, $from_time: DateTime!) {
        user(login: $login) {
          contributionsCollection(from: $from_time) {
            totalCommitContributions
            restrictedContributionsCount
          }
        }
      }
      `, variables,
  }, {
    Authorization: `bearer ${token}`,
  },);
};

// https://github.com/anuraghazra/github-readme-stats/issues/92#issuecomment-661026467
// https://github.com/anuraghazra/github-readme-stats/pull/211/
const totalCommitsFetcher = async (username, contributionYears) => {
  if (!githubUsernameRegex.test(username)) {
    logger.log("Invalid username");
    return 0;
  }

  let totalPublicCommits = 0;
  let totalPrivateCommits = 0;

  try {
    await Promise.all(contributionYears.map(async (year) => {
          let variables = {
            login: username,
            from_time: `${year}-01-01T00:00:00.000Z`,
          };
          let res = await retryer(fetchYearCommits, variables);
          totalPublicCommits += res.data.data.user.contributionsCollection.totalCommitContributions;
          totalPrivateCommits += res.data.data.user.contributionsCollection.restrictedContributionsCount;
        })
    );
    return {
      totalPublicCommits,
      totalPrivateCommits,
    };
  } catch (err) {
    logger.log(err);
    // just return 0 if there is something wrong so that
    // we don't break the whole app
    return {
      totalPublicCommits: 0,
      totalPrivateCommits: 0,
    };
  }
};

/**
 * @param {string} username
 * @param {boolean} count_private
 * @param {boolean} include_all_commits
 * @returns {Promise<import("./types").StatsData>}
 */
async function fetchStats(
  username,
  count_private = false,
  include_all_commits = false,
) {
  if (!username) throw new MissingParamError(["username"]);

  const stats = {
    name: "",
    totalPRs: 0,
    totalCommits: 0,
    totalIssues: 0,
    totalStars: 0,
    contributedTo: 0,
    rank: { level: "C", score: 0 },
  };

  let res = await retryer(fetcher, { login: username });

  if (res.data.errors) {
    logger.error(res.data.errors);
    throw new CustomError(
      res.data.errors[0].message || "Could not fetch user",
      CustomError.USER_NOT_FOUND,
    );
  }

  const user = res.data.data.user;

  stats.name = user.name || user.login;
  stats.totalIssues = user.openIssues.totalCount + user.closedIssues.totalCount;

  // normal commits
  stats.totalCommits = user.contributionsCollection.totalCommitContributions;

  let privateCommits = user.contributionsCollection.restrictedContributionsCount;

  // if include_all_commits then just get that,
  // since totalCommitsFetcher already sends totalCommits no need to +=
  if (include_all_commits) {
    const { totalPublicCommits, totalPrivateCommits } = await totalCommitsFetcher(username, user.contributionsCollection.contributionYears);
    stats.totalCommits = totalPublicCommits;
    privateCommits = totalPrivateCommits;
  }

  // if count_private then add private commits to totalCommits so far.
  if (count_private) {
    stats.totalCommits += privateCommits;
  }

  stats.totalPRs = user.pullRequests.totalCount;
  stats.contributedTo = user.repositoriesContributedTo.totalCount;

  stats.totalStars = user.repositories.nodes.reduce((prev, curr) => {
    return prev + curr.stargazers.totalCount;
  }, 0);

  stats.rank = calculateRank({
    totalCommits: stats.totalCommits,
    totalRepos: user.repositories.totalCount,
    followers: user.followers.totalCount,
    contributions: stats.contributedTo,
    stargazers: stats.totalStars,
    prs: stats.totalPRs,
    issues: stats.totalIssues,
  });

  return stats;
}

module.exports = fetchStats;
