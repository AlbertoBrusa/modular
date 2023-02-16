import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import resolve from 'resolve';
import { Paths } from '../../utils/determineTargetPaths';

/**
 * Get additional module paths based on the baseUrl of a compilerOptions object.
 *
 * @param {Object} options
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getAdditionalModulePaths(options: any = {}, paths: Paths) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const baseUrl = options.baseUrl;

  if (!baseUrl) {
    return '';
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const baseUrlResolved = path.resolve(paths.appPath, baseUrl);

  // We don't need to do anything if `baseUrl` is set to `node_modules`. This is
  // the default behavior.
  if (path.relative(paths.appNodeModules, baseUrlResolved) === '') {
    return null;
  }

  // Allow the user set the `baseUrl` to `appSrc`.
  if (path.relative(paths.appSrc, baseUrlResolved) === '') {
    return [paths.appSrc];
  }

  // If the path is equal to the root directory we ignore it here.
  // We don't want to allow importing from the root directly as source files are
  // not transpiled outside of `src`. We do allow importing them with the
  // absolute path (e.g. `src/Components/Button.js`) but we set that up with
  // an alias.
  if (path.relative(paths.appPath, baseUrlResolved) === '') {
    return null;
  }

  // Otherwise, throw an error.
  throw new Error(
    chalk.red.bold(
      "Your project's `baseUrl` can only be set to `src` or `node_modules`." +
        ' Create React App does not support other values at this time.',
    ),
  );
}

/**
 * Get webpack aliases based on the baseUrl of a compilerOptions object.
 *
 * @param {*} options
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getWebpackAliases(options: any = {}, paths: Paths) {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const baseUrl = options.baseUrl;

  if (!baseUrl) {
    return {};
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  const baseUrlResolved = path.resolve(paths.appPath, baseUrl);

  if (path.relative(paths.appPath, baseUrlResolved) === '') {
    return {
      src: paths.appSrc,
    };
  }
}

export default function getModules(paths: Paths) {
  // Check if TypeScript is setup
  const hasTsConfig = fs.existsSync(paths.appTsConfig);
  const hasJsConfig = fs.existsSync(paths.appJsConfig);

  if (hasTsConfig && hasJsConfig) {
    throw new Error(
      'You have both a tsconfig.json and a jsconfig.json. If you are using TypeScript please remove your jsconfig.json file.',
    );
  }

  let config;

  // If there's a tsconfig.json we assume it's a
  // TypeScript project and set up the config
  // based on tsconfig.json
  if (hasTsConfig) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-var-requires
    const ts = require(resolve.sync('typescript', {
      basedir: paths.appNodeModules,
    }));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    config = ts.readConfigFile(paths.appTsConfig, ts.sys.readFile).config;
    // Otherwise we'll check if there is jsconfig.json
    // for non TS projects.
  } else if (hasJsConfig) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    config = require(paths.appJsConfig);
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  config = config || {};
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const options = config.compilerOptions || {};

  const additionalModulePaths = getAdditionalModulePaths(options, paths);

  return {
    additionalModulePaths: additionalModulePaths,
    webpackAliases: getWebpackAliases(options, paths),
    hasTsConfig,
  };
}
