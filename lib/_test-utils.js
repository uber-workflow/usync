/** Copyright (c) 2019 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const path = require('path');
const execa = require('execa');
const fse = require('fs-extra');
const globby = require('globby');
const {equals: isEqual} = require('expect/build/jasmineUtils');
const sanitizeFilename = require('sanitize-filename');
const {Git} = require('./git.js');

let FIXTURE_COUNT = 0;

/**
 * this is just a shorthand for doing fs stuff without
 * a million `path.join`s and whatnot hurting readability
 */
class FileEditor {
  constructor(dirpath) {
    this.dirpath = dirpath;
  }

  /**
   * @param {string} filename
   * @returns {string}
   */
  getFullPath(filename) {
    // `resolve` used so type of slashes doesn't matter
    return path.resolve(this.dirpath, filename);
  }

  /**
   * `cd` command; change directory for the file editor
   *
   * @param {string} dirpath
   */
  cd(dirpath) {
    this.dirpath = path.resolve(this.dirpath, dirpath);
  }

  /**
   * @param {string} oldPath
   * @param {string} newPath
   * @returns {Promise<void>}
   */
  async move(oldPath, newPath) {
    return fse.move(this.getFullPath(oldPath), this.getFullPath(newPath));
  }

  /**
   * @param {string} filename
   * @returns {Promise<string>}
   */
  async read(filename) {
    return fse.readFile(this.getFullPath(filename), 'utf-8');
  }

  /**
   * @param {string} filename
   * @returns {Promise<void>}
   */
  async remove(filename) {
    return fse.remove(this.getFullPath(filename));
  }

  /**
   * @param {string} filename
   * @param {number} lineIndex
   * @returns {Promise<void>}
   */
  async removeLine(filename, lineIndex) {
    const lines = (await this.read(filename)).split('\n');

    lines.splice(lineIndex, 1);
    return this.write(filename, lines.join('\n'));
  }

  /**
   * @param {string} filename
   * @param {string} content
   * @returns {Promise<void>}
   */
  async write(filename, content) {
    const fullPath = this.getFullPath(filename);

    await fse.ensureDir(path.dirname(fullPath));
    return fse.writeFile(fullPath, content);
  }
}

/**
 * @typedef {{
 *   editor: FileEditor,
 *   git: Git,
 * }} Fixture
 */

/**
 * @param {string} dir
 * @param {string} repoName
 * @returns {Promise<Fixture>}
 */
async function createFixture(dir, repoName = `foo/fixture${FIXTURE_COUNT++}`) {
  const repoPath = path.join(dir, sanitizeFilename(repoName));

  await fse.ensureDir(repoPath);
  await execa('git', ['init'], {cwd: repoPath});
  // make initial commit
  await fse.writeFile(path.join(repoPath, 'foo.txt'), 'foo');
  await execa('git', ['add', 'foo.txt'], {cwd: repoPath});
  await execa('git', ['commit', '-m', 'init commit'], {cwd: repoPath});

  const git = new Git(repoName);
  git.repoPath = repoPath;
  return {
    editor: new FileEditor(repoPath),
    git,
  };
}

/**
 * @param {Fixture} fixture
 * @param {string} forkName
 * @returns {Promise<Fixture>}
 */
async function forkFixture(fixture, forkName) {
  const fixturePath = fixture.git.repoPath;
  const forkPath = path.join(
    path.dirname(fixturePath),
    sanitizeFilename(forkName),
  );

  await fse.copy(fixturePath, forkPath);
  const git = new Git(forkName);
  git.repoPath = forkPath;
  return {
    editor: new FileEditor(forkPath),
    git,
  };
}

/**
 * @returns {Promise<string>} 'Name <email>'
 */
async function getGlobalGitUser() {
  const args = ['config', '--global', '--get'];
  const {stdout: email} = await execa('git', [...args, 'user.email']);
  const {stdout: name} = await execa('git', [...args, 'user.name']);

  return `${name} <${email}>`;
}

/**
 * Generate `n` paragraphs of dummy content
 *
 * @param {number} n number of paragraphs
 * @returns {string}
 */
function generateParagraphs(n) {
  const paragraph = `Blah${' blah'.repeat(80)}.`;
  let result = paragraph;

  n--;
  for (; n; n--) result += `\n\n${paragraph}`;
  return result;
}

/**
 * Indicates whether the file trees and contents
 * of provided `targetDirs` match the `sourceDir`
 *
 * @param {string} sourceDir
 * @param {...string} targetDirs
 * @returns {Promise<boolean>}
 */
async function filesMatch(sourceDir, ...targetDirs) {
  if (!targetDirs.filter(Boolean).length) return false;

  const globOpts = {dot: true, ignore: ['.git']};
  const tree = await globby('**/*', {cwd: sourceDir, ...globOpts}).then(tree =>
    tree.sort((a, b) => a.localeCompare(b)),
  );

  try {
    await Promise.all(
      targetDirs.map(async targetDir => {
        const targetTree = await globby('**/*', {
          cwd: targetDir,
          ...globOpts,
        }).then(tree => tree.sort((a, b) => a.localeCompare(b)));

        if (!isEqual(tree, targetTree)) {
          throw new Error('break');
        }

        await Promise.all(
          tree.map(async filepath => {
            const sourceContent = await fse.readFile(
              path.join(sourceDir, filepath),
              'utf-8',
            );
            const targetContent = await fse.readFile(
              path.join(targetDir, filepath),
              'utf-8',
            );

            if (sourceContent !== targetContent) {
              throw new Error('break');
            }
          }),
        );
      }),
    );
  } catch (error) {
    if (error.message === 'break') {
      return false;
    } else {
      throw error;
    }
  }

  return true;
}

module.exports = {
  createFixture,
  FileEditor,
  filesMatch,
  forkFixture,
  generateParagraphs,
  getGlobalGitUser,
};
