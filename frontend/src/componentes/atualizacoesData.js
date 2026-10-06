function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function compareVersions(left, right) {
  const parse = (value) => {
    const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return null;
    return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return normalizeVersion(right).localeCompare(normalizeVersion(left));
  for (let index = 0; index < a.numbers.length; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return b.numbers[index] - a.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return -1;
  if (!b.prerelease) return 1;
  return a.prerelease.localeCompare(b.prerelease);
}

export function releaseNoteItems(releaseNotes) {
  const text = String(releaseNotes || '').replace(/<!--[^]*?-->/g, '').trim();
  if (!text) return [];
  const items = text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim()).filter(Boolean);
  if (items.length) return items;
  const prose = text.replace(/^#+\s+.*$/gm, '').trim();
  return prose ? [prose] : [];
}

function releaseWithNotes(release) {
  const version = normalizeVersion(release && release.version);
  const releaseNotes = typeof (release && release.releaseNotes) === 'string' ? release.releaseNotes.trim() : '';
  if (!version || !releaseNotes || releaseNoteItems(releaseNotes).length === 0) return null;
  return { version, releaseNotes };
}

export function partitionReleaseCatalog({ installedRelease, availableRelease, releaseHistory } = {}) {
  const installedVersion = normalizeVersion(installedRelease && installedRelease.version);
  const availableVersion = normalizeVersion(availableRelease && availableRelease.version);
  const installed = releaseWithNotes(installedRelease);
  const available = releaseWithNotes(availableRelease);
  const byVersion = new Map();
  if (installed) byVersion.set(installed.version, installed);
  if (available) byVersion.set(available.version, available);
  for (const release of Array.isArray(releaseHistory) ? releaseHistory : []) {
    const normalized = releaseWithNotes(release);
    if (normalized && !byVersion.has(normalized.version)) byVersion.set(normalized.version, normalized);
  }
  const releases = [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
  const currentVersion = availableVersion || installedVersion;
  if (currentVersion) {
    return {
      currentRelease:
        (availableVersion && available && byVersion.get(available.version)) ||
        (installedVersion && installed && byVersion.get(installed.version)) ||
        byVersion.get(currentVersion) ||
        null,
      historyReleases: releases.filter((release) => release.version !== currentVersion),
    };
  }
  return { currentRelease: releases[0] || null, historyReleases: releases.slice(1) };
}
