import path from 'node:path'

export function emptyUpgradeProjectIDs(projects, sessions, workspace, emptyDefault) {
  if (!emptyDefault || typeof workspace !== 'string' || !Array.isArray(projects)) return []
  const directory = workspace.replace(/\/+$/, '') + '/默认项目'
  if (Array.isArray(sessions) && sessions.some(item => typeof item?.location?.directory === 'string' && item.location.directory.replace(/\/+$/, '') === directory)) return []
  // If history could not be read, do not retire a project whose sessions are unknown.
  if (!Array.isArray(sessions)) return []
  return projects.filter(item => typeof item?.id === 'string' && typeof item.canonical === 'string' && item.canonical.replace(/\/+$/, '') === directory).map(item => item.id)
}

// Recover directory identities, never invent a new directory or rename a project.
export function recoverProjectIDs(projects, sessions, workspace, emptyDefault = false) {
  if (!Array.isArray(projects)) return []
  const clean = value => typeof value === 'string' ? value.replace(/\/+$/, '') || '/' : undefined
  const base = clean(workspace)
  const used = new Set(Array.isArray(sessions) ? sessions.map(item => clean(item?.location?.directory)).filter(Boolean) : [])
  const eligible = projects.filter(item => {
    if (typeof item?.id !== 'string' || typeof item.canonical !== 'string') return false
    const directory = clean(item.canonical)
    if (used.has(directory) || directory === base) return true
    if (directory === '/' || ['.npm', '.cache'].includes(path.posix.basename(directory))) return false
    return !(emptyDefault && Array.isArray(sessions) && base && directory === base + '/默认项目')
  })
  // New drafts use the original shared directory, not the upgrade-created folder.
  const shared = eligible.filter(item => clean(item.canonical) === base)
  const historical = eligible.filter(item => used.has(clean(item.canonical)))
  return [...new Set([...shared, ...historical, ...eligible].map(item => item.id))].slice(0, 100)
}
