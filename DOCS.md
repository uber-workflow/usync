# Using uSync

uSync is meant to be a generic tool to import and subsequently land changes made across synced repos. This allows you to implement the developer experience however you want, and just let uSync handle configuration and git.

```js
const {USync} = require('usyncit');

// provide parent monorepo name so it knows where to look
// for config and where to import into
const usync = new USync('myorg/monorepo');
```


## usync.import(opts)

Import a branch from an external repo into the monorepo.

```js
await usync.import({
  baseRepoName: 'my-open-source-org/some-repo',
  headBranch: 'feature/add-thing',
  message: 'Add thing',
  newBranch: 'imports/feature/add-thing',
});
```

#### opts.baseRepoName

<sup>Type: `String`, **Required**</sup>

#### opts.headBranch

<sup>Type: `String`, **Required**</sup>

#### opts.headRepoName

<sup>Type: `String`</sup>

Only required if the change was authored from a fork.

#### opts.message

<sup>Type: `String`, **Required**</sup>

#### opts.newBranch

<sup>Type: `String`, **Required**</sup>


## usync.land(opts)

Land a branch from the monorepo into all configured external repos.

```js
const landedRepos = await usync.land({
  commitMessages: {
    generic: 'Add thing',
  },
  headBranch: 'imports/feature/add-thing',
});

// sha of commit landed in master for each repo
landedRepos['myorg/monorepo'].sha
landedRepos['my-open-source-org/some-repo'].sha
```

#### opts.commitMessages

<sup>Type: `Object`, **Required**</sup>

Commit messages to use for the repos involved.

#### opts.commitMessages.generic

<sup>Type: `String`, **Required**</sup>

Default message to use for any repos that don't have a custom message provided.

#### opts.commitMessages[repoName]

<sup>Type: `String`</sup>

Provide a custom commit message for a repo. For example, if many changes were authored across the monorepo, and you want to provide a message specific only to the changes that will be landed in an external repo.

#### opts.fallbackBranch

<sup>Type: `String`</sup>

Only required in case git isn't able to push to `master` for some reason (e.g. branch permissions). Since this is possibly a partial failure, uSync will push the landed change to the `fallbackBranch` of any repos it failed to push to.

#### opts.headBranch

<sup>Type: `String`, **Required**</sup>

#### opts.headRepoName

<sup>Type: `String`</sup>

Only required if the change was authored from a fork.

## Git.configure(opts)

Depending on your implementation, you may need to customize certain aspects of the git operations. This is possible via `Git.configure`.

```js
const {Git} = require('usyncit');

Git.configure(opts);
```

#### opts.getRemoteUrl

<sup>Type: `Function`</sup>

By default, uSync is setup for only GitHub repos:

```js
function getRemoteUrl(repoName) {
  return `https://x-access-token:${process.env.GH_TOKEN}@github.com/${repoName}.git`;
}
```

But if you wanted to, for example, support repos across multiple git hosting services, you could do something like this:

```js
Git.configure({
  getRemoteUrl(repoName) {
    // any references to repos (i.e. `.usyncrc.json`, `import` options, `land` options)
    // that start with 'gitlab:' use a different remote url format
    if (repoName.startsWith('gitlab:')) {
      // construct gitlab remote url
    } else {
      // default to github
    }
  },
});
```
