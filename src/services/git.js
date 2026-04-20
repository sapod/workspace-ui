import { fetchJsonAbsolute } from '../common/utils';

async function getGitStatus(path) {
  return fetchJsonAbsolute(`/git-status?path=${encodeURIComponent(path || '')}`);
}

async function getGitDiff(path, file) {
  return fetchJsonAbsolute(`/git-diff?path=${encodeURIComponent(path || '')}&file=${encodeURIComponent(file)}`);
}

export const git = {
  getGitStatus,
  getGitDiff,
};