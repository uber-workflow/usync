# uSync

[![Build status](https://badge.buildkite.com/b261e65e2871a2025986979ef6c8ef0cccd67f7972b3371254.svg?branch=master)](https://buildkite.com/uberopensource/usync)

> Sync subdirectories of a monorepo with external repos

## Setup

### In your monorepo

**.usyncrc.json**

```js
{
  "$schema": "https://github.com/uber-workflow/usync/blob/v0.0.1-0/schema/.usyncrc.json",
  "mapping": {
    // setup directory mappings per external repo
    "my-open-source-org/some-repo": {
      // sync `/projects/some-repo` with root of external repo
      "/projects/some-repo": "/"
    }
  }
}
```

### On your server

#### Install

```sh
yarn add usyncit
```

#### Use

The example below is using fictitious utils for handling webhooks and dealing with pull requests to illustrate the workflow. You'll need to roll your own handling of those things.

uSync is meant to be a generic tool to import and subsequently land changes made across synced repos. This allows you to implement the developer experience however you want, and just let uSync handle git.

```js
const {USync} = require('usyncit');
const usync = new USync('myorg/monorepo');
const {closePR, createPR, handleSomeWebhook} = require('./my/org/utils.js');

handleSomeWebhook('import', async prInfo => {
  const monorepoBranchName = `imports/${prInfo.branch}`;

  await usync.import({
    // e.g. my-open-source-org/some-repo
    baseRepoName: prInfo.repoName,
    // only required if being imported from forked repo
    // headRepoName: '',
    headBranch: prInfo.branch,
    message: prInfo.title,
    newBranch: monorepoBranchName,
  });

  // create new PR in monorepo for imported branch
  await createPR('myorg/monorepo', monorepoBranchName, prInfo.title);
  // close imported PR
  await closePR(prInfo.id);
});

handleSomeWebhook('land', async prInfo => {
  const landedRepos = await usync.land({
    baseRepoName: 'myorg/monorepo',
    commitMessages: {
      // default message used if no explicit message provided
      generic: 'Make lots of changes across monorepo',
      // custom message provided for this repo
      'my-open-source-org/some-repo': 'Make changes to some-repo',
    },
    // only required as a backup in case the configured auth
    // token is unable to push to master
    // fallbackBranch: '',
    headBranch: prInfo.branch,
    // only required if being imported from forked repo
    // headRepoName: '',
  });

  // sha of commit landed in master
  // landedRepos['myorg/monorepo'].sha

  // close landed PR
  await closePR(prInfo.id);
});
```
