/** Copyright (c) 2019 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

const path = require('path');
const fse = require('fs-extra');
const {getGlobalUser} = require('./git.js');
const {createFixture} = require('./_test-utils.js');

const TEMP_DIR = path.resolve(__dirname, '../.tmp/git-fixtures');

afterAll(async () => {
  const rootTempDir = path.resolve(TEMP_DIR, '..');

  await fse.remove(TEMP_DIR);
  if (!(await fse.readdir(rootTempDir)).length) {
    await fse.remove(rootTempDir);
  }
});

test.concurrent('git.raw()', async () => {
  const {git} = await createFixture(TEMP_DIR);

  await git.raw(['config', 'user.name', 'Test Person']);
  expect(await git.raw(['config', '--get', 'user.name'])).toBe('Test Person');
});

test.concurrent('git.getCurrentBranch()', async () => {
  const {git} = await createFixture(TEMP_DIR);

  expect(await git.getCurrentBranch()).toBe('master');
  await git.raw(['checkout', '-b', 'test-branch']);
  expect(await git.getCurrentBranch()).toBe('test-branch');
});

test.concurrent('git.log()', async () => {
  const {git} = await createFixture(TEMP_DIR);

  expect(
    await git.log(['-1'], {
      message: '%s',
    }),
    // from initial commit in `createFixture`
  ).toEqual([{message: 'init commit'}]);
});

test.concurrent('git.getLogAuthors()', async () => {
  const {git} = await createFixture(TEMP_DIR);
  const globalUser = await getGlobalUser();

  await git.raw(['config', 'user.name', 'Test Person 1']);
  await git.raw(['config', 'user.email', 'test-person-1@uber.com']);
  await fse.writeFile(path.join(git.repoPath, 'bar.txt'), 'bar');
  await git.raw(['add', 'bar.txt']);
  await git.raw([
    'commit',
    '-m',
    'add bar\n\nCo-authored-by: Test Person 2 <test-person-2@uber.com>',
  ]);

  expect(await git.getLogAuthors([])).toEqual(
    [
      globalUser,
      'Test Person 1 <test-person-1@uber.com>',
      'Test Person 2 <test-person-2@uber.com>',
    ].sort((a, b) => a.localeCompare(b)),
  );
});

test.concurrent('git.workdirIsClean()', async () => {
  const {git} = await createFixture(TEMP_DIR);

  expect(await git.workdirIsClean()).toBe(true);
  await fse.writeFile(path.join(git.repoPath, 'bar.txt'), 'bar');
  expect(await git.workdirIsClean()).toBe(false);
  await git.raw(['add', 'bar.txt']);
  expect(await git.workdirIsClean()).toBe(false);
  await git.raw(['reset', '--hard', 'HEAD']);
  expect(await git.workdirIsClean()).toBe(true);
});
