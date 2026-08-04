// repo 包出口：GitLab 集成的对外唯一入口。
// 分层：gitlab-api（REST）→ archive（落盘）→ code-context（上下文提取），
// paths / sensitive 为被上述模块复用的纯校验层。

'use strict';

const gitlabApi = require('./gitlab-api');
const archive = require('./archive');
const codeContext = require('./code-context');
const paths = require('./paths');
const sensitive = require('./sensitive');

module.exports = {
  REPOS_DIR: archive.REPOS_DIR,
  // 配置
  getGitlabCfg: gitlabApi.getGitlabCfg,
  setGitlabCfg: gitlabApi.setGitlabCfg,
  maskedCfg: gitlabApi.maskedCfg,
  // REST
  testConnection: gitlabApi.testConnection,
  listProjects: gitlabApi.listProjects,
  listBranches: gitlabApi.listBranches,
  // 快照
  syncModule: archive.syncModule,
  walk: archive.walk,
  // 上下文
  dirTree: codeContext.dirTree,
  keyFilesContent: codeContext.keyFilesContent,
  buildCodeContext: codeContext.buildCodeContext,
  // 安全校验（admin 层入参校验复用）
  isValidModuleKey: paths.isValidModuleKey,
  assertModuleKey: paths.assertModuleKey,
  isSafeRelPath: paths.isSafeRelPath,
  assertSafeRelPath: paths.assertSafeRelPath,
  isSensitiveFile: sensitive.isSensitiveFile,
  redactSecrets: sensitive.redactSecrets,
};
