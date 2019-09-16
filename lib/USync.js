/** Copyright (c) 2019 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const {performance} = require('perf_hooks');
const {default: PQueue} = require('p-queue');
const prettyMS = require('pretty-ms');
const git = require('./git.js');

/**
 * Shorthand for tracking the speed of something
 *
 * @returns {() => string} endTimer: function that returns readable duration
 */
function startTimer() {
  const start = performance.now();
  return () => prettyMS(performance.now() - start);
}

// end-user-friendly errors for things like invalid `.usyncrc.json`, etc
class USyncError extends Error {
  constructor(...args) {
    super(...args);
    this.name = 'USyncError';

    /* istanbul ignore next */
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, USyncError);
    }
  }
}

class USync {
  constructor(parentRepoName) {
    this.parentRepoName = parentRepoName;
    this.parentGit = new git.Git(parentRepoName);
    this.queue = new PQueue({concurrency: 1});

    // use queue for methods
    this.import = this._passThroughQueue(this.import.bind(this));
    this.land = this._passThroughQueue(this.land.bind(this));
  }

  /**
   * @param {*} config
   * @returns {void}
   */
  static validateConfig(config) {
    if (!config || typeof config.mapping !== 'object') {
      throw new USyncError(
        `Missing or invalid \`.usyncrc.json\` in parent repo`,
      );
    }
  }

  _passThroughQueue(method) {
    return (...args) => this.queue.add(() => method(...args));
  }

  /**
   * @param {string} [committish] get config at a particular commit
   * @returns {object | void}
   */
  async _getConfig(committish = 'HEAD') {
    try {
      const config = JSON.parse(
        await this.parentGit.raw(['show', `${committish}:.usyncrc.json`]),
      );

      if (config && config.mapping) {
        // strip leading/trailing slashes in mappings
        for (const [repoName, mapping] of Object.entries(config.mapping)) {
          config.mapping[repoName] = Object.entries(mapping).reduce(
            (result, entry) => {
              const [key, value] = entry.map(p => p.replace(/^\/|\/$/g, ''));

              result[key] = value;
              return result;
            },
            {},
          );
        }
      }

      return config;
    } catch (error) {
      console.error(`error reading config: ${error.message}`);
    }
  }

  /**
   * @param {{
   *   baseRepoName: string,
   *   headBranch: string,
   *   message: string,
   *   newBranch: string,
   *   headRepoName?: string,
   * }} opts
   * @returns {Promise<void>}
   */
  async import(opts) {
    const endTimer = startTimer();
    const {parentGit} = this;
    const {baseRepoName, headRepoName, headBranch, message, newBranch} = opts;

    await parentGit.fetchLatest();
    const config = await this._getConfig();
    USync.validateConfig(config);

    if (
      !config.mapping[baseRepoName] ||
      !Object.keys(config.mapping[baseRepoName]).length
    ) {
      throw new USyncError(
        `No mapping found for \`${baseRepoName}\` in parent repo's \`.usyncrc.json\``,
      );
    }

    const isFork = headRepoName && headRepoName !== baseRepoName;
    const remoteName = isFork ? git.getRemoteName(headRepoName) : 'origin';
    const childGit = new git.Git(baseRepoName);

    // prepare
    {
      await Promise.all([
        parentGit.fetchLatest(),
        (async () => {
          await childGit.fetchLatest();
          if (isFork) {
            await childGit.addForkRemote(headRepoName);
          }
          await childGit.raw(['fetch', remoteName, headBranch]);
        })(),
      ]);
    }

    // import
    {
      const mapping = config.mapping[baseRepoName];
      const configSubpaths = Object.values(mapping).filter(Boolean);
      const logArgs = [
        `HEAD...${remoteName}/${headBranch}`,
        '--right-only',
        // only include authors of commits that modify files in this repo
        ...(configSubpaths.length ? ['--', ...configSubpaths] : []),
      ];
      const [globalUser, commitAuthor] = await Promise.all([
        git.getGlobalUser(),
        childGit
          .log(logArgs, {author: '%an <%ae>'})
          .then(commits => commits[0].author),
      ]);
      const commitMessage = await childGit
        .getLogAuthors(logArgs)
        .then(authors => {
          const trailers = authors
            .filter(author => author !== commitAuthor && author !== globalUser)
            .map(author => `Co-authored-by: ${author}`)
            .join('\n');

          return trailers ? `${message}\n\n${trailers}` : message;
        });

      await childGit.raw(['merge', '--squash', `${remoteName}/${headBranch}`]);
      await parentGit.raw(['checkout', '-b', newBranch]);
      for (const [parentPath, childPath] of Object.entries(mapping)) {
        const diffArgs = ['--cached', '--binary'];
        const applyArgs = [];

        if (childPath) {
          diffArgs.push(childPath);
          // strips `n` paths from diff filepaths (+1 is because 1 is the default value)
          applyArgs.push(`-p${1 + childPath.split('/').length}`);
        }

        if (parentPath) {
          applyArgs.push(`--directory=${parentPath}`);
        }

        const diff = await childGit.raw(['diff', ...diffArgs]);
        if (!diff) return;

        try {
          // pipe diff into `git apply`
          const proc = parentGit.raw(['apply', ...applyArgs], true);
          // `git apply` fails without the git version footer
          proc.stdin.end(`${diff}\n--\n${git.version}`);
          await proc;
        } catch (error) {
          console.error(
            `failed to apply diff in ${this.parentRepoName}:\n${error.stderr}\n`,
          );
          throw error;
        }
      }

      await parentGit.raw(['add', '--all']);
      await parentGit.raw([
        'commit',
        `--author=${commitAuthor}`,
        `--message=${commitMessage}`,
      ]);
      await parentGit.raw(['push', '--force', 'origin', newBranch]);
    }

    // cleanup
    {
      await Promise.all([
        (async () => {
          await parentGit.raw(['checkout', 'master']);
          await parentGit.raw(['branch', '-D', newBranch]);
        })(),
        (async () => {
          await childGit.raw(['reset', '--hard', 'HEAD']);
          if (isFork) {
            await childGit.removeForkRemote(headRepoName);
          }
        })(),
      ]);
    }

    console.log(
      `Imported from '${headRepoName ||
        baseRepoName}:${headBranch}' - ${endTimer()}`,
    );
  }

  /**
   * @param {{
   *   commitMessages: {generic: string} & Object<string, string>,
   *   fallbackBranch: string,
   *   headBranch: string,
   *   headRepoName?: string,
   * }} opts
   * @returns {Promise<Object<string, {
   *   sha: string,
   * }>>} landedRepos
   */
  async land(opts) {
    const endTimer = startTimer();
    const {parentGit, parentRepoName} = this;
    const {commitMessages, fallbackBranch, headRepoName, headBranch} = opts;
    const isFork = headRepoName && headRepoName !== parentRepoName;
    const remoteName = isFork ? git.getRemoteName(headRepoName) : 'origin';
    const landedRepos = {};

    // prepare
    {
      await parentGit.fetchLatest();
      if (isFork) {
        await parentGit.addForkRemote(headRepoName);
      }
      await parentGit.raw(['fetch', remoteName, headBranch]);
    }

    // land
    try {
      const config = await this._getConfig(`${remoteName}/${headBranch}`);
      USync.validateConfig(config);

      await parentGit.raw(['merge', '--squash', `${remoteName}/${headBranch}`]);
      // first apply the change to all repos. this is done in its own
      // loop so that if any repos fail to apply, the whole land fails
      await Promise.all(
        Object.entries(config.mapping).map(async ([repoName, mapping]) => {
          if (!Object.keys(mapping).length) return;

          const repoGit = new git.Git(repoName);

          await repoGit.fetchLatest();
          for (const [parentPath, childPath] of Object.entries(mapping)) {
            const diffArgs = ['--cached', '--binary'];
            const applyArgs = [];

            if (parentPath) {
              diffArgs.push(parentPath);
              // strips `n` paths from diff filepaths (+1 is because 1 is the default value)
              applyArgs.push(`-p${1 + parentPath.split('/').length}`);
            }

            if (childPath) {
              applyArgs.push(`--directory=${childPath}`);
            }

            const diff = await parentGit.raw(['diff', ...diffArgs]);
            if (!diff) return;

            try {
              // pipe diff into `git apply`
              const proc = repoGit.raw(['apply', ...applyArgs], true);
              // `git apply` fails without the git version footer
              proc.stdin.end(`${diff}\n--\n${git.version}`);
              await proc;
            } catch (error) {
              console.error(
                `failed to apply diff in ${repoName}:\n${error.stderr}\n`,
              );
              throw error;
            }
          }
        }),
      );

      const globalUser = await git.getGlobalUser();
      const failedPushRepos = [];
      // add a dummy mapping for parent repo so we can handle it in the
      // loop with the rest of the repos
      config.mapping[parentRepoName] = {'': ''};

      // now that we know all repos received the patch successfully,
      // commit the change
      await Promise.all(
        Object.entries(config.mapping).map(async ([repoName, mapping]) => {
          const repoGit = new git.Git(repoName);

          // nothing to land
          if (await repoGit.workdirIsClean()) return;

          const configSubpaths = Object.keys(mapping).filter(Boolean);
          const logArgs = [
            `HEAD...${remoteName}/${headBranch}`,
            '--right-only',
            // only include authors of commits that modify files in this repo
            ...(configSubpaths.length ? ['--', ...configSubpaths] : []),
          ];
          // use author of first commit in branch as the squashed
          // commit author
          const commitAuthor = await parentGit
            .log(logArgs, {author: '%an <%ae>'})
            .then(commits => commits[0].author);
          const commitMessage = await parentGit
            .getLogAuthors(logArgs)
            .then(authors => {
              const message =
                commitMessages[repoName] || commitMessages.generic;
              const trailers = authors
                .filter(
                  author => author !== commitAuthor && author !== globalUser,
                )
                .map(author => `Co-authored-by: ${author}`)
                .join('\n');

              return trailers ? `${message}\n\n${trailers}` : message;
            });

          await repoGit.raw(['add', '--all']);
          await repoGit.raw([
            'commit',
            `--author=${commitAuthor}`,
            `--message=${commitMessage}`,
          ]);

          try {
            await repoGit.raw(['push']);

            landedRepos[repoName] = {
              sha: await repoGit.raw(['log', '-1', '--format=%H']),
            };
          } catch (e) {
            failedPushRepos.push(repoName);
            console.error(e.stderr);
          }
        }),
      );

      if (failedPushRepos.length) {
        await Promise.all(
          failedPushRepos.map(async repoName => {
            const repoGit = new git.Git(repoName);

            await repoGit.raw(['checkout', '-b', fallbackBranch]);
            await repoGit.raw(['push', 'origin', fallbackBranch]);
          }),
        );

        throw new USyncError(
          `Unable to push to \`master\` for:\n${failedPushRepos
            .map(repoName => `- ${repoName}`)
            .join(
              '\n',
            )}\n\nPushed to \`${fallbackBranch}\` branch instead. **Please manually merge the branch(es) into \`master\` ASAP**.\n\n*NOTE: to prevent this, you likely need to adjust your branch protection rules or ensure the \`GH_TOKEN\` account has admin access to your repos.*`,
        );
      }
    } finally {
      // cleanup
      if (isFork) {
        await parentGit.removeForkRemote(headRepoName);
      }
    }

    console.log(`Landed '${headBranch}' - ${endTimer()}`);
    return landedRepos;
  }
}

module.exports = {
  USync,
  USyncError,
};
