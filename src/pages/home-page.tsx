import { startTransition, useState } from 'react'
import { Link, useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'
import { BrandMark } from '../components/brand-mark'
import { RenameSheet } from '../components/rename-sheet'
import { loadHomeProjects, type ProjectSummary } from '../lib/project-actions'
import { createProject, deleteProject, renameProject } from '../lib/storage'
import { MAX_PROJECTS, formatDuration, type Project } from '../lib/types'

export async function homeLoader(): Promise<ProjectSummary[]> {
  return loadHomeProjects()
}

export function HomePage() {
  const projects = useLoaderData() as ProjectSummary[]
  const revalidator = useRevalidator()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<Project | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = () => {
    startTransition(() => {
      void revalidator.revalidate()
    })
  }

  return (
    <div className="screen">
      <div className="home-hero">
        <BrandMark size={64} className="brand-mark" />
        <p className="eyebrow">Kody · on-device</p>
        <h1 className="brand">
          Go Video <span>Go</span>
        </h1>
        <p className="lede">Hold the screen to record highlights. Private until you share.</p>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {projects.length === 0 ? (
        <div className="empty-state">
          <h2 style={{ fontFamily: 'var(--font-display)', margin: '0 0 8px' }}>Start a project</h2>
          <p className="muted" style={{ margin: 0, maxWidth: '30ch', lineHeight: 1.45 }}>
            Up to {MAX_PROJECTS} projects stay in this browser. Refresh-safe via IndexedDB — nothing
            uploads.
          </p>
        </div>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id} className="project-row">
              <Link to={`/project/${project.id}`}>
                <strong>{project.name}</strong>
                <small>
                  {project.clipCount} clip{project.clipCount === 1 ? '' : 's'} ·{' '}
                  {formatDuration(project.durationMs)}
                </small>
              </Link>
              <div className="project-actions">
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Rename ${project.name}`}
                  onClick={() => setRenaming(project)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="btn-icon"
                  aria-label={`Delete ${project.name}`}
                  onClick={() => {
                    if (!confirm(`Delete “${project.name}” and all its clips?`)) return
                    void (async () => {
                      await deleteProject(project.id)
                      refresh()
                    })()
                  }}
                >
                  ⌫
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="home-footer">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || projects.length >= MAX_PROJECTS}
          onClick={() => {
            void (async () => {
              setBusy(true)
              setError(null)
              try {
                const project = await createProject()
                navigate(`/project/${project.id}`)
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Could not create project')
              } finally {
                setBusy(false)
              }
            })()
          }}
        >
          {projects.length >= MAX_PROJECTS ? `Limit ${MAX_PROJECTS}` : 'New project'}
        </button>
      </div>

      {renaming ? (
        <RenameSheet
          key={renaming.id}
          initialName={renaming.name}
          onClose={() => setRenaming(null)}
          onSave={async (name) => {
            await renameProject(renaming.id, name)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
