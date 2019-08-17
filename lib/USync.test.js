/** Copyright (c) 2019 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const path = require('path');
const execa = require('execa');
const fse = require('fs-extra');
const sanitizeFilename = require('sanitize-filename');
const {Git} = require('./git.js');
const {USync, USyncError} = require('./USync.js');
const {
  createFixture,
  filesMatch,
  forkFixture,
  generateParagraphs,
  getGlobalGitUser,
} = require('./_test-utils.js');

const TEMP_DIR = path.resolve(__dirname, '../.tmp/USync-fixtures');
const CLONES_DIR = path.join(TEMP_DIR, 'clones');
const REMOTES_DIR = path.join(TEMP_DIR, 'remotes');

Git.configure({
  reposCloneDir: CLONES_DIR,
  getRemoteUrl(repoName) {
    // use local fixture dir path as remote url
    return path.join(REMOTES_DIR, `${sanitizeFilename(repoName)}.git`);
  },
});

async function convertToRemote(repoPath) {
  const repoName = repoPath.split(path.sep).slice(-1)[0];

  await execa('git', [
    'clone',
    '--bare',
    path.join(repoPath, '.git'),
    path.join(REMOTES_DIR, `${repoName}.git`),
  ]);
  await fse.remove(repoPath);
}

afterAll(async () => {
  const rootTempDir = path.resolve(TEMP_DIR, '..');

  await fse.remove(TEMP_DIR);
  if (!(await fse.readdir(rootTempDir)).length) {
    await fse.remove(rootTempDir);
  }
});

test('USync.validateConfig()', () => {
  // invalid
  expect(() => USync.validateConfig({})).toThrow(USyncError);
  expect(() =>
    USync.validateConfig({
      mapping: {
        'foo/repo': {
          '/subdir': '/child-subdir',
        },
      },
    }),
  ).toThrow(USyncError);

  // valid
  expect(() => USync.validateConfig({mapping: {}})).not.toThrow();
  expect(() =>
    USync.validateConfig({
      mapping: {
        'foo/repo': {
          '/subdir': '/',
        },
      },
    }),
  ).not.toThrow();
});

describe('usync.import()', () => {
  test.concurrent('imports file changes into new branch', async () => {
    const parentName = 'foo/import-parent';
    const childName = 'foo/import-child';
    const subdir = 'sub-dir';
    const changeBranch = 'my-test-change';

    // prepare repos
    {
      const parent = await createFixture(CLONES_DIR, parentName);
      const child = await createFixture(CLONES_DIR, childName);

      // setup initial states (before change is authored)
      {
        await parent.editor.write(
          '.usyncrc.json',
          JSON.stringify({
            mapping: {
              [childName]: {
                [subdir]: '/',
              },
            },
          }),
        );

        parent.editor.cd(subdir);
        // copy change from child's init commit
        await parent.editor.write(`foo.txt`, 'foo');
        for (const repo of [parent, child]) {
          // enough content so that git doesn't consider rename + modify
          // to be just a new file
          const fileContent = generateParagraphs(3);

          await Promise.all([
            repo.editor.write('file-to-delete.txt', fileContent),
            repo.editor.write('some/dir/file-to-delete.txt', fileContent),
            repo.editor.write('file-to-rename.txt', fileContent),
            repo.editor.write('foo/file-to-move.txt', fileContent),
            repo.editor.write('file-to-modify.txt', fileContent),
            repo.editor.write('foo/file-to-modify.txt', fileContent),
            repo.editor.write('file-to-rename-and-modify.txt', fileContent),
          ]);
          await repo.git.raw(['add', '--all']);
          await repo.git.raw(['commit', '-m', 'setup pre-import state']);
        }
      }

      // author the changes that will be imported
      {
        const newFilesContent = generateParagraphs(1);

        await child.git.raw(['checkout', '-b', changeBranch]);
        await Promise.all([
          child.editor.remove('file-to-delete.txt'),
          child.editor.remove('some/dir/file-to-delete.txt'),
          child.editor.move('file-to-rename.txt', 'file-renamed.txt'),
          child.editor.move('foo/file-to-move.txt', 'file-moved.txt'),
        ]);
        await child.git.raw(['add', '--all']);
        await child.git.raw(['commit', '-m', 'do some changes']);
        await Promise.all([
          child.editor.write('file-added.txt', newFilesContent),
          child.editor.write('foo/file-added.txt', newFilesContent),
          child.editor.removeLine('file-to-modify.txt', 0),
          child.editor.removeLine('foo/file-to-modify.txt', 0),
          child.editor.removeLine('file-to-rename-and-modify.txt', 0),
        ]);
        await child.editor.move(
          'file-to-rename-and-modify.txt',
          'file-renamed-and-modified.txt',
        );
        await child.git.raw(['add', '--all']);
        await child.git.raw(['commit', '-m', 'do more changes']);
        await child.git.raw(['checkout', 'master']);
      }

      await Promise.all([
        convertToRemote(parent.git.repoPath),
        convertToRemote(child.git.repoPath),
      ]);
    }

    // import changes
    {
      const globalGitUser = await getGlobalGitUser();
      const usync = new USync(parentName);
      const parentGit = new Git(parentName);
      const childGit = new Git(childName);
      const commitMessage = 'Make a bunch of changes';

      await usync.import({
        baseRepoName: childName,
        headBranch: changeBranch,
        message: commitMessage,
        newBranch: `imports/${changeBranch}`,
      });

      await parentGit.raw(['checkout', `imports/${changeBranch}`]);
      await childGit.raw(['checkout', changeBranch]);

      expect(
        await filesMatch(
          childGit.repoPath,
          path.join(parentGit.repoPath, subdir),
        ),
      ).toBe(true);
      expect(await parentGit.log([-1], {message: '%B'})).toEqual([
        {message: `${commitMessage}\n\nCo-authored-by: ${globalGitUser}`},
      ]);
    }
  });

  test.concurrent('handles importing from a fork', async () => {
    const parentName = 'foo/import-fork-parent';
    const childName = 'foo/import-fork-child';
    const childForkName = 'bar/import-fork-child';
    const subdir = 'sub-dir';
    const changeBranch = 'change-from-fork';

    // prepare repos
    {
      const parent = await createFixture(CLONES_DIR, parentName);
      const child = await createFixture(CLONES_DIR, childName);

      // setup initial states (before change is authored)
      {
        await parent.editor.write(
          '.usyncrc.json',
          JSON.stringify({
            mapping: {
              [childName]: {
                [subdir]: '/',
              },
            },
          }),
        );

        parent.editor.cd(subdir);
        // copy change from child's init commit
        await parent.editor.write('foo.txt', 'foo');
        for (const repo of [parent, child]) {
          await repo.editor.write('file-to-modify.txt', generateParagraphs(3));
          await repo.git.raw(['add', '--all']);
          await repo.git.raw(['commit', '-m', 'setup pre-import state']);
        }
      }

      const fork = await forkFixture(child, childForkName);

      // author the changes that will be imported
      {
        await fork.git.raw(['checkout', '-b', changeBranch]);
        await fork.editor.removeLine('file-to-modify.txt', 0);
        await fork.git.raw(['add', '--all']);
        await fork.git.raw(['commit', '-am', 'modify file']);
        await fork.git.raw(['checkout', 'master']);
      }

      await Promise.all([
        convertToRemote(parent.git.repoPath),
        convertToRemote(child.git.repoPath),
        convertToRemote(fork.git.repoPath),
      ]);
    }

    // import changes
    {
      const globalGitUser = await getGlobalGitUser();
      const usync = new USync(parentName);
      const parentGit = new Git(parentName);
      const childForkGit = new Git(childForkName);
      const commitMessage = 'Make a change from forked repo';

      await usync.import({
        baseRepoName: childName,
        headRepoName: childForkName,
        headBranch: changeBranch,
        message: commitMessage,
        newBranch: `imports/${changeBranch}`,
      });

      await parentGit.raw(['checkout', `imports/${changeBranch}`]);
      await childForkGit.fetchLatest();
      await childForkGit.raw(['checkout', changeBranch]);

      expect(
        await filesMatch(
          childForkGit.repoPath,
          path.join(parentGit.repoPath, subdir),
        ),
      ).toBe(true);
      expect(await parentGit.log([-1], {message: '%B'})).toEqual([
        {message: `${commitMessage}\n\nCo-authored-by: ${globalGitUser}`},
      ]);
    }
  });
});

describe('usync.land()', () => {
  test.concurrent('lands change in parent and configured repos', async () => {
    const parentName = 'foo/land-parent';
    const childName = 'foo/land-child';
    const subdir = 'sub-dir';
    const changeBranch = 'my-test-change';

    // prepare repos
    {
      const parent = await createFixture(CLONES_DIR, parentName);
      const child = await createFixture(CLONES_DIR, childName);

      // setup initial states (before change is authored)
      {
        await parent.editor.write(
          '.usyncrc.json',
          JSON.stringify({
            mapping: {
              [childName]: {
                [subdir]: '/',
              },
            },
          }),
        );

        parent.editor.cd(subdir);
        // copy change from child's init commit
        await parent.editor.write('foo.txt', 'foo');
        for (const repo of [parent, child]) {
          // enough content so that git doesn't consider rename + modify
          // to be just a new file
          const fileContent = generateParagraphs(3);

          await Promise.all([
            repo.editor.write('file-to-delete.txt', fileContent),
            repo.editor.write('some/dir/file-to-delete.txt', fileContent),
            repo.editor.write('file-to-rename.txt', fileContent),
            repo.editor.write('foo/file-to-move.txt', fileContent),
            repo.editor.write('file-to-modify.txt', fileContent),
            repo.editor.write('foo/file-to-modify.txt', fileContent),
            repo.editor.write('file-to-rename-and-modify.txt', fileContent),
          ]);
          await repo.git.raw(['add', '--all']);
          await repo.git.raw(['commit', '-m', 'setup pre-land state']);
        }
      }

      // author the changes that will be landed
      {
        const newFilesContent = generateParagraphs(1);

        await parent.git.raw(['checkout', '-b', changeBranch]);
        await Promise.all([
          parent.editor.remove('file-to-delete.txt'),
          parent.editor.remove('some/dir/file-to-delete.txt'),
          parent.editor.move('file-to-rename.txt', 'file-renamed.txt'),
          parent.editor.move('foo/file-to-move.txt', 'file-moved.txt'),
        ]);
        await parent.git.raw(['add', '--all']);
        await parent.git.raw(['commit', '-m', 'do some changes']);
        await Promise.all([
          parent.editor.write('file-added.txt', newFilesContent),
          parent.editor.write('foo/file-added.txt', newFilesContent),
          parent.editor.removeLine('file-to-modify.txt', 0),
          parent.editor.removeLine('foo/file-to-modify.txt', 0),
          parent.editor.removeLine('file-to-rename-and-modify.txt', 0),
        ]);
        await parent.editor.move(
          'file-to-rename-and-modify.txt',
          'file-renamed-and-modified.txt',
        );
        await parent.git.raw(['add', '--all']);
        await parent.git.raw(['commit', '-m', 'do more changes']);
        await parent.git.raw(['checkout', 'master']);
      }

      await Promise.all([
        convertToRemote(parent.git.repoPath),
        convertToRemote(child.git.repoPath),
      ]);
    }

    // land changes
    {
      const globalGitUser = await getGlobalGitUser();
      const usync = new USync(parentName);
      const parentGit = new Git(parentName);
      const childGit = new Git(childName);
      const commitMessage = 'Make a bunch of changes';
      const landedRepos = await usync.land({
        commitMessages: {
          generic: commitMessage,
        },
        fallbackBranch: 'fallback-branch',
        headBranch: changeBranch,
      });

      expect(
        await filesMatch(
          childGit.repoPath,
          path.join(parentGit.repoPath, subdir),
        ),
      ).toBe(true);
      expect(Object.keys(landedRepos).sort()).toEqual(
        [parentName, childName].sort(),
      );
      expect(await parentGit.log([-1], {message: '%B'})).toEqual([
        {message: `${commitMessage}\n\nCo-authored-by: ${globalGitUser}`},
      ]);
      expect(await childGit.log([-1], {message: '%B'})).toEqual([
        {message: `${commitMessage}\n\nCo-authored-by: ${globalGitUser}`},
      ]);
    }
  });

  test.concurrent('supports a single file changed', async () => {
    const parentName = 'foo/land-single-file-parent';
    const childName = 'foo/land-single-file-child';
    const subdir = 'sub-dir';
    const changeBranch = 'my-test-change';

    // prepare repos
    {
      const parent = await createFixture(CLONES_DIR, parentName);
      const child = await createFixture(CLONES_DIR, childName);

      // setup initial states (before change is authored)
      {
        await parent.editor.write(
          '.usyncrc.json',
          JSON.stringify({
            mapping: {
              [childName]: {
                [subdir]: '/',
              },
            },
          }),
        );

        parent.editor.cd(subdir);
        // copy change from child's init commit
        await parent.editor.write(`foo.txt`, 'foo');
        for (const repo of [parent, child]) {
          const fileContent = generateParagraphs(3);

          await repo.editor.write('file-to-rename.txt', fileContent);
          await repo.git.raw(['add', '--all']);
          await repo.git.raw(['commit', '-m', 'setup pre-land state']);
        }
      }

      // author the changes that will be imported
      {
        await parent.git.raw(['checkout', '-b', changeBranch]);
        await parent.editor.move('file-to-rename.txt', 'file-renamed.txt');
        await parent.git.raw(['add', '--all']);
        await parent.git.raw(['commit', '-m', 'rename file']);
        await parent.git.raw(['checkout', 'master']);
      }

      await Promise.all([
        convertToRemote(parent.git.repoPath),
        convertToRemote(child.git.repoPath),
      ]);
    }

    // land changes
    {
      const usync = new USync(parentName);
      const parentGit = new Git(parentName);
      const childGit = new Git(childName);
      const commitMessage = 'Rename file';

      await usync.land({
        commitMessages: {
          generic: commitMessage,
        },
        fallbackBranch: 'fallback-branch',
        headBranch: changeBranch,
      });

      expect(
        await filesMatch(
          childGit.repoPath,
          path.join(parentGit.repoPath, subdir),
        ),
      ).toBe(true);
    }
  });
});
