import { fetchJsonAbsolute, postJsonAbsolute } from '../common/utils';

function gitRequest(action, body = {}) {
  return postJsonAbsolute(`/git/${action}`, body);
}

async function getGitStatus(path) {
  return gitRequest('status', { path });
}

async function getGitDiff(path, file) {
  return gitRequest('diff', { path, file });
}

async function commitFiles(path, files, message) {
  return gitRequest('commit', { path, files, message });
}

async function rollbackFiles(path, files) {
  return gitRequest('rollback', { path, files });
}

async function getCommitList(path, limit = 20) {
  return gitRequest('log', { path, limit });
}

export const git = {
  getGitStatus,
  getGitDiff,
  commitFiles,
  rollbackFiles,
  getCommitList,
};