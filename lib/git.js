/** Copyright (c) 2019 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const path = require('path');
const execa = require('execa');
const fse = require('fs-extra');
const pick = require('just-pick');
const sanitizeFilename = require('sanitize-filename');

const {GH_TOKEN} = process.env;
const GIT_VERSION = execa.sync('git', ['--version']).stdout;
// Math.random() * 10e8
const formatHash = 209735749.31388405;
const FORMAT_FIELD_BOUNDARY = formatHash.toString(36);
const FORMAT_COMMIT_BOUNDARY = (formatHash * 2).toString(36);
const GLOBAL_OPTS = {
  reposCloneDir: path.resolve(__dirname, '../.local-repos'),
  /* istanbul ignore next */
  getRemoteUrl(repoName) {
    return `https://x-access-token:${GH_TOKEN}@github.com/${repoName}.git`;
  },
};

class Git {
  constructor(repoName) {
    this.repoName = repoName;
    this.repoPath = getLocalPath(repoName);
  }

  /**
   * Configure global options for git operations
   *
   * @param {{
   *   getRemoteUrl?: (repoName: string) => string,
   *   reposCloneDir?: string,
   * }} opts
   */
  static configure(opts) {
    const {getRemoteUrl, reposCloneDir} = opts;

    if (
      (getRemoteUrl && typeof getRemoteUrl !== 'function') ||
      (reposCloneDir && typeof reposCloneDir !== 'string')
    ) {
      throw new Error('invalid git opts');
    }

    Object.assign(GLOBAL_OPTS, pick(opts, ['getRemoteUrl', 'reposCloneDir']));
  }

  /**
   * @param {string[]} args
   * @param {boolean} [shouldReturnProcess]
   * @returns {GitReturnType}
   */
  raw(args, shouldReturnProcess) {
    return git(this.repoPath, args, shouldReturnProcess);
  }

  async getCurrentBranch() {
    return this.raw(['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  /**
   * @param {string} forkRepoName
   * @returns {Promise<void>}
   */
  async addForkRemote(forkRepoName) {
    return this.raw([
      'remote',
      'add',
      getRemoteName(forkRepoName),
      GLOBAL_OPTS.getRemoteUrl(forkRepoName),
    ]);
  }

  /**
   * @param {string} forkRepoName
   * @returns {Promise<void>}
   */
  async removeForkRemote(forkRepoName) {
    return this.raw(['remote', 'remove', getRemoteName(forkRepoName)]);
  }

  /**
   * Fetch latest master from origin and reset local
   * master to it
   *
   * @returns {Promise<void>}
   */
  async fetchLatest() {
    await ensureClone(this.repoName);
    const currentBranch = await this.getCurrentBranch();

    /* istanbul ignore next */
    if (currentBranch !== 'master') {
      await this.raw(['clean', '-df']);
      await this.raw(['reset', '--hard', 'HEAD']);
      await this.raw(['checkout', 'master']);

      if (currentBranch !== 'HEAD') {
        await this.raw(['branch', '-D', currentBranch]);
      }
    }

    await this.raw(['fetch', 'origin', 'master']);
    await this.raw(['reset', '--hard', 'origin/master']);
  }

  /**
   * Call `git log` with the provided `args` and format it based
   * on the provided `schema`. See git docs for supported % vars:
   * https://git-scm.com/docs/git-log#_pretty_formats
   *
   * @template Schema
   * @param {string[]} args
   * @param {Schema} schema
   * @returns {Promise<Schema[]>}
   * @example
   * await git.log(['HEAD', '-5'], {
   *   sha: '%H',
   *   authorName: '%an',
   * })
   */
  async log(args, schema) {
    const schemaKeys = Object.keys(schema);
    const schemaArg =
      '--pretty=format:' +
      schemaKeys.map(k => schema[k]).join(FORMAT_FIELD_BOUNDARY) +
      FORMAT_COMMIT_BOUNDARY;

    return this.raw(['log', schemaArg, ...args]).then(res =>
      res
        .trim()
        .split(FORMAT_COMMIT_BOUNDARY + '\n')
        .map(commit => commit.replace(FORMAT_COMMIT_BOUNDARY, ''))
        .filter(Boolean)
        .map(commit =>
          commit
            .trim()
            .split(FORMAT_FIELD_BOUNDARY)
            .reduce((result, value, i) => {
              result[schemaKeys[i]] = value;
              return result;
            }, {}),
        ),
    );
  }

  /**
   * Call `git log` with the provided `logArgs` and get
   * all involved authors (both direct commit authors
   * and `Co-authored-by:`)
   *
   * @param {string[]} logArgs
   * @returns {Promise<string[]>} authors in `name <email>` format
   */
  async getLogAuthors(logArgs) {
    const commits = await this.log(logArgs, {
      authorEmail: '%ae',
      authorName: '%an',
      message: '%B',
    });
    const authorsSet = commits.reduce((set, commit) => {
      set.add(`${commit.authorName} <${commit.authorEmail}>`);

      for (const line of commit.message.split('\n')) {
        if (line.startsWith('Co-authored-by: ')) {
          set.add(line.slice(16));
        }
      }

      return set;
    }, new Set());

    return [...authorsSet].sort((a, b) => a.localeCompare(b));
  }

  /**
   * @returns {Promise<boolean>}
   */
  async workdirIsClean() {
    return this.raw(['status', '--porcelain']).then(res => !res.trim());
  }
}

/**
 * @typedef {import('execa').ExecaChildProcess | Promise<string>} GitReturnType
 */
/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {boolean} [shouldReturnProcess]
 * @returns {GitReturnType}
 */
function git(cwd, args, shouldReturnProcess) {
  const result = execa('git', args, {cwd});

  if (shouldReturnProcess) {
    return result;
  } else {
    return result
      .then(res => res.stdout)
      .catch(error => {
        console.error(`git error:\n${error.stderr}\n`);
        throw error;
      });
  }
}

async function ensureClone(repoName) {
  if (!(await fse.pathExists(getLocalPath(repoName)))) {
    await fse.ensureDir(GLOBAL_OPTS.reposCloneDir);
    return git(GLOBAL_OPTS.reposCloneDir, [
      'clone',
      // possibly could speed up monorepo clones with --depth, but
      // might be difficult to determine how deep we need to go
      GLOBAL_OPTS.getRemoteUrl(repoName),
      getLocalPath(repoName),
    ]);
  }
}

function getRemoteName(repoName) {
  return repoName.split('/')[0];
}

function getLocalPath(repoName) {
  return path.join(GLOBAL_OPTS.reposCloneDir, sanitizeFilename(repoName));
}

module.exports = {
  getLocalPath,
  getRemoteName,
  Git,
  version: GIT_VERSION,
};
