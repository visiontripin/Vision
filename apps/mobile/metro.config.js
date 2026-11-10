const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * `@vision/shared` — отдельный пакет в корне репозитория и подключается симлинком
 * (`file:../../packages/shared`). Metro по умолчанию не ходит за пределы проекта,
 * поэтому добавляем корень в watchFolders и подсказываем пути к node_modules.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@vision/shared': path.resolve(workspaceRoot, 'packages/shared'),
};

module.exports = config;
