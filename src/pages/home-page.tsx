import { startTransition, useState } from 'react'
import { Link, useLoaderData, useNavigate, useRevalidator } from 'react-router-dom'
import { BlobImage } from '../components/blob-image'
import { BrandMark } from '../components/brand-mark'
import { ConfirmSheet } from '../components/confirm-sheet'
import { HomeOptionsSheet } from '../components/home-options-sheet'
import { IconMore, IconPlus } from '../components/icons'
import { RenameSheet } from '../components/rename-sheet'
import { loadHomeProjects, type ProjectSummary } from '../lib/project-actions'
import { createProject, deleteProject, renameProject } from '../lib/storage'
import { MAX_PROJECTS, formatDuration } from '../lib/types'

export async function homeLoader(): Promise<ProjectSummary[]> {
  return loadHomeProjects()
}

export function HomePage() {
  const projects = useLoaderData() as ProjectSummary[]
  const revalidator = useRevalidator()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [menuProject, setMenuProject] = useState<ProjectSummary | null>(null)
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
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
  const atCap = projects.length >= MAX_PROJECTS

  return (
    <div className="screen home-screen">
      <div className="home-hero">
        <div className="home-hero-art" aria-hidden="true">
          <BrandMark size={96} className="brand-hero-art" variant="camera" />
        </div>
        <h1 className="brand">
          Kody <span>Video</span>
        </h1>
        <p className="lede">Hold to record. Tap OK to share.</p>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="project-slots" aria-label="Kody Video projects">
        {slots.map((project, index) =>
          project ? (
            <article
              key={project.id}
              className={project.posterThumb ? 'project-slot filled has-poster' : 'project-slot filled'}
            >
              {project.posterThumb ? (
                <BlobImage
                  blob={project.posterThumb}
                  className="slot-poster"
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                />
              ) : null}
              <div className="slot-fade" aria-hidden="true" />
              <Link className="slot-open" to={`/project/${project.id}`}>
                <span className="slot-number">Slot {index + 1}</span>
                <strong>{project.name}</strong>
                <small>
                  {project.clipCount} clip{project.clipCount === 1 ? '' : 's'} ·{' '}
                  {formatDuration(project.durationMs)}
                </small>
              </Link>
              <button
                type="button"
                className="slot-options"
                aria-label={`Options for ${project.name}`}
                onClick={() => setMenuProject(project)}
              >
                <IconMore />
              </button>
            </article>
          ) : (
            <button
              key={`empty-${index}`}
              type="button"
              className="project-slot empty"
              disabled={busy || atCap}
              onClick={createAndOpenProject}
            >
              <span className="slot-plus" aria-hidden="true">
                <IconPlus size={26} />
              </span>
              <strong>New project</strong>
              <small>{atCap ? 'Six-project limit' : `Slot ${index + 1}`}</small>
            </button>
          ),
        )}
      </section>

      <p className="home-privacy">Clips stay on this phone until you share.</p>

      <div className="home-footer">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || atCap}
          onClick={createAndOpenProject}
        >
          {atCap ? `Limit ${MAX_PROJECTS}` : 'New project'}
        </button>
      </div>

      {menuProject ? (
        <HomeOptionsSheet
          projectName={menuProject.name}
          onClose={() => setMenuProject(null)}
          onOpen={() => {
            const id = menuProject.id
            setMenuProject(null)
            navigate(`/project/${id}`)
          }}
          onRename={() => {
            setRenaming(menuProject)
            setMenuProject(null)
          }}
          onDelete={() => {
            setDeleting(menuProject)
            setMenuProject(null)
          }}
        />
      ) : null}

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

      {deleting ? (
        <ConfirmSheet
          title="Delete project?"
          message={`Delete “${deleting.name}” and all its clips? This can’t be undone.`}
          confirmLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await deleteProject(deleting.id)
            refresh()
          }}
        />
      ) : null}
    </div>
  )
}
