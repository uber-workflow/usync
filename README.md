# uSync

[![Build status](https://badge.buildkite.com/b261e65e2871a2025986979ef6c8ef0cccd67f7972b3371254.svg?branch=master)](https://buildkite.com/uberopensource/usync)

> Sync subdirectories of a monorepo with external repos


## Setup your monorepo

Configuration for synced repos exists as a json file in the root of your monorepo; this allows your configuration to be versioned along with your code.

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


## Setup your server

### Install

```sh
yarn add usyncit
```


### Provide environment vars

`GH_TOKEN`

Used in the remote url when cloning repos (see docs on [customizing git](DOCS.md#gitconfigureopts)). Must be from an account that has write access to repos in your org.


### Use

```js
const {USync} = require('usyncit');

// provide parent monorepo name so it knows where to look
// for config and where to import into
const usync = new USync('myorg/monorepo');

yourImportWebhookHandler(async () => {
  await usync.import(...);
});

yourLandWebhookHandler(async () => {
  await usync.land(...);
});
```

See [DOCS.md](DOCS.md) for full usage info.


## License

[MIT](LICENSE)
