const {isPlainObject} = require('lodash');
const marked = require('marked');
const TerminalRenderer = require('marked-terminal');
const envCi = require('env-ci');
const hookStd = require('hook-std');
const pEachSeries = require('p-each-series');
const semver = require('semver');
const AggregateError = require('aggregate-error');
const pkg = require('./package.json');
const hideSensitive = require('./lib/hide-sensitive');
const getConfig = require('./lib/get-config');
const verify = require('./lib/verify');
const getNextVersion = require('./lib/get-next-version');
const getCommits = require('./lib/get-commits');
const getLastRelease = require('./lib/get-last-release');
const getReleasesToAdd = require('./lib/get-releases-to-add');
const {extractErrors, makeTag} = require('./lib/utils');
const getGitAuthUrl = require('./lib/get-git-auth-url');
const logger = require('./lib/logger');
const {verifyAuth, isBranchUpToDate, gitHead: getGitHead, tag, push} = require('./lib/git');
const getError = require('./lib/get-error');
const {COMMIT_NAME, COMMIT_EMAIL} = require('./lib/definitions/constants');

marked.setOptions({renderer: new TerminalRenderer()});

async function run(options, plugins) {
  const {isCi, branch: ciBranch, isPr} = envCi();

  if (!isCi && !options.dryRun && !options.noCi) {
    logger.log('This run was not triggered in a known CI environment, running in dry-run mode.');
    options.dryRun = true;
  } else {
    // When running on CI, set the commits author and commiter info and prevent the `git` CLI to prompt for username/password. See #703.
    process.env = {
      GIT_AUTHOR_NAME: COMMIT_NAME,
      GIT_AUTHOR_EMAIL: COMMIT_EMAIL,
      GIT_COMMITTER_NAME: COMMIT_NAME,
      GIT_COMMITTER_EMAIL: COMMIT_EMAIL,
      ...process.env,
      GIT_ASKPASS: 'echo',
      GIT_TERMINAL_PROMPT: 0,
    };
  }

  if (isCi && isPr && !options.noCi) {
    logger.log("This run was triggered by a pull request and therefore a new version won't be published.");
    return;
  }

  // Verify config
  await verify(options);

  const branch = options.branches.find(({name}) => name === ciBranch);

  if (!branch) {
    logger.log(
      `This test run was triggered on the branch ${ciBranch}, while semantic-release is configured to only publish from ${options.branches
        .map(({name}) => name)
        .join(', ')}, therefore a new version won’t be published.`
    );
    return false;
  }

  options.repositoryUrl = await getGitAuthUrl(options);

  try {
    await verifyAuth(options.repositoryUrl, branch.name);
  } catch (err) {
    if (!(await isBranchUpToDate(options.branch))) {
      logger.log(
        "The local branch %s is behind the remote one, therefore a new version won't be published.",
        options.branch
      );
      return false;
    }
    logger.error(`The command "${err.cmd}" failed with the error message %s.`, err.stderr);
    throw getError('EGITNOPERMISSION', {options});
  }

  logger.log('Run automated release from branch %s', ciBranch);

  await plugins.verifyConditions({options, branch, logger});

  const releasesToAdd = getReleasesToAdd(branch, options, logger);
  const errors = [];

  await pEachSeries(releasesToAdd, async ({lastRelease, currentRelease, nextRelease}) => {
    if (branch['merge-range'] && !semver.satisfies(nextRelease.version, branch['merge-range'])) {
      errors.push(getError('EINVALIDLTSMERGE', {nextRelease, branch}));
      return;
    }

    const commits = await getCommits(lastRelease.gitHead, nextRelease.gitHead, branch.name, logger);
    nextRelease.notes = await plugins.generateNotes({options, logger, branch, lastRelease, commits, nextRelease});

    logger.log('Create tag %s', nextRelease.gitTag);
    await tag(nextRelease.gitTag, nextRelease.gitHead);
    await push(options.repositoryUrl, branch.name);

    await plugins.success({
      options,
      logger,
      branch,
      lastRelease,
      commits,
      nextRelease,
      releases: await plugins.addChannel({options, logger, branch, lastRelease, commits, currentRelease, nextRelease}),
    });
  });

  if (errors.length > 0) {
    throw new AggregateError(errors);
  }

  const lastRelease = getLastRelease(branch, options, logger);

  const {channel} = branch;
  const commits = await getCommits(lastRelease.gitHead, 'HEAD', branch.name, logger);

  const type = await plugins.analyzeCommits({options, branch, lastRelease, commits, logger});
  if (!type) {
    logger.log('There are no relevant changes, so no new version is released.');
    return;
  }

  const nextVersion = getNextVersion(branch, type, lastRelease, logger);
  const versionNumber = semver.valid(semver.coerce(nextVersion))

  if (!semver.satisfies(versionNumber, branch.range)) {
    throw getError('EINVALIDNEXTVERSION', { versionNumber, branch });
  }

  const nextRelease = {
    type,
    version: nextVersion,
    channel,
    gitHead: await getGitHead(),
    gitTag: makeTag(options.tagFormat, nextVersion, channel),
    name: makeTag(options.tagFormat, nextVersion),
  };

  await plugins.verifyRelease({ options, logger, branch, lastRelease, commits, nextRelease });

  const generateNotesParam = {options, branch, lastRelease, commits, nextRelease, logger};

  if (options.dryRun) {
    const notes = await plugins.generateNotes(generateNotesParam);
    logger.log('Release note for version %s:\n', nextRelease.version);
    process.stdout.write(`${marked(notes)}\n`);
  } else {
    nextRelease.notes = await plugins.generateNotes(generateNotesParam);
    await plugins.prepare({options, branch, lastRelease, commits, nextRelease, logger});

    // Create the tag before calling the publish plugins as some require the tag to exists
    logger.log('Create tag %s', nextRelease.gitTag);
    await tag(nextRelease.gitTag);
    await push(options.repositoryUrl, branch.name);

    const releases = await plugins.publish({options, branch, lastRelease, commits, nextRelease, logger});

    logger.log('Published release: %s', nextRelease.version);

    await plugins.success({options, branch, lastRelease, commits, nextRelease, releases, logger});
  }
  return true;
}

function logErrors(err) {
  const errors = extractErrors(err).sort(error => (error.semanticRelease ? -1 : 0));
  for (const error of errors) {
    if (error.semanticRelease) {
      logger.log(`%s ${error.message}`, error.code);
      if (error.details) {
        process.stdout.write(`${marked(error.details)}\n`);
      }
    } else {
      logger.error('An error occurred while running semantic-release: %O', error);
    }
  }
}

async function callFail(plugins, options, error) {
  const errors = extractErrors(error).filter(error => error.semanticRelease);
  if (errors.length > 0) {
    try {
      await plugins.fail({options, logger, errors});
    } catch (err) {
      logErrors(err);
    }
  }
}

module.exports = async opts => {
  logger.log(`Running %s version %s`, pkg.name, pkg.version);
  const {unhook} = hookStd({silent: false}, hideSensitive);
  try {
    const config = await getConfig(opts, logger);
    const {plugins, options} = config;
    try {
      const result = await run(options, plugins);
      unhook();
      return result;
    } catch (err) {
      if (!options.dryRun) {
        await callFail(plugins, options, err);
      }
      throw err;
    }
  } catch (err) {
    logErrors(err);
    unhook();
    throw err;
  }
};
