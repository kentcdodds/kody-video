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

  const createAndOpenProject = () => {
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
  }

  const slots = Array.from({ length: MAX_PROJECTS }, (_, index) => projects[index] ?? null)

  return (
    <div className="screen">
      <div className="home-hero">
        <BrandMark size={72} className="brand-mark" />
        <p className="eyebrow">Kody · on-device</p>
        <h1 className="brand">
          Kody <span>Video</span>
        </h1>
        <p className="lede">
          Six local clip projects. Hold anywhere to record, tap OK when it feels ready.
        </p>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="project-slots" aria-label="Kody Video projects">
        {slots.map((project, index) =>
          project ? (
            <article key={project.id} className="project-slot filled">
              <Link className="slot-open" to={`/project/${project.id}`}>
                <span className="slot-number">Slot {index + 1}</span>
                <strong>{project.name}</strong>
                <small>
                  {project.clipCount} clip{project.clipCount === 1 ? '' : 's'} ·{' '}
                  {formatDuration(project.durationMs)}
                </small>
              </Link>
              <div className="project-actions">
                <button
                  type="button"
                  className="btn btn-ghost"
                  aria-label={`Rename ${project.name}`}
                  onClick={() => setRenaming(project)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="btn btn-ghost danger"
                  aria-label={`Delete ${project.name}`}
                  onClick={() => {
                    if (!confirm(`Delete "${project.name}" and all its clips?`)) return
                    void (async () => {
                      await deleteProject(project.id)
                      refresh()
                    })()
                  }}
                >
                  Delete
                </button>
              </div>
            </article>
          ) : (
            <button
              key={`empty-${index}`}
              type="button"
              className="project-slot empty"
              disabled={busy || projects.length >= MAX_PROJECTS}
              onClick={createAndOpenProject}
            >
              <span className="slot-number">Slot {index + 1}</span>
              <strong>New Kody</strong>
              <small>Tap to create a private project</small>
            </button>
          ),
        )}
      </section>

      <div className="home-footer">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || projects.length >= MAX_PROJECTS}
          onClick={createAndOpenProject}
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
