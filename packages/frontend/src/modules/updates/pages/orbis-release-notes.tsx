import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { IconChevronDown } from '@tabler/icons-react';
import { useLocation } from 'react-router';
import { Markdown } from '@/components/markdown/markdown';
import { includedOrbisReleases, groupOrbisReleaseNotes, orbisReleaseHistoryOptions, type OrbisRelease } from '@/desktop/orbis-release';
import { useWindowVisible } from '@/desktop/window-visibility';
import './orbis-release-notes.css';

function ReleaseNote({
  release,
  expanded,
  alreadyInstalled = false,
  children,
}: {
  release: OrbisRelease;
  expanded: boolean;
  alreadyInstalled?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(expanded);
  return (
    <details className="desktop-release-note" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span title={release.tag}>{release.tag}</span>
        {release.publishedAt ? <time dateTime={release.publishedAt}>{new Date(release.publishedAt).toLocaleDateString()}</time> : null}
        <IconChevronDown size={18} aria-hidden="true" />
      </summary>
      {open ? (
        <div className="desktop-release-note-content">
          {alreadyInstalled ? <p className="desktop-release-context">Feature overview — already installed.</p> : null}
          {release.body ? (
            <Markdown
              content={release.body.trimStart().replace(/^#\s+Orbis[^\n]*\r?\n(?:\r?\n)*/i, '')}
              className="desktop-update-markdown"
              tabIndex={0}
              label={`${release.tag} changelog`}
            />
          ) : (
            <p>
              No changelog provided.{' '}
              <a href={release.url} target="_blank" rel="noreferrer">
                View this release on GitHub
              </a>
              .
            </p>
          )}
          {children}
        </div>
      ) : null}
    </details>
  );
}

export function OrbisReleaseNotes({ latest, installed }: { latest: OrbisRelease; installed: string | undefined }) {
  const titleId = useId();
  const visible = useWindowVisible();
  const entry = useLocation().key;
  const lastEntry = useRef(entry);
  const options = orbisReleaseHistoryOptions(installed, latest.tag);
  const history = useQuery({ ...options, enabled: visible && options.enabled, staleTime: 60_000, refetchOnMount: 'always' });
  useEffect(() => {
    if (lastEntry.current === entry) return;
    lastEntry.current = entry;
    if (visible && options.enabled) void history.refetch();
  }, [entry, visible, options.enabled, history.refetch]);
  const releases = includedOrbisReleases(latest, installed, history.data?.releases);
  const groups = groupOrbisReleaseNotes(releases, history.data?.context);
  const hasFeature = groups.some((group) => group.feature);
  return (
    <section className="desktop-release-history" aria-labelledby={titleId}>
      <h3 id={titleId}>Changelog</h3>
      {options.enabled ? (
        <p className="desktop-release-history-intro">This update includes all changes since {installed}, including any updates you skipped.</p>
      ) : null}
      {options.enabled && history.isPending ? <output>Reading included release notes…</output> : null}
      {history.isError || (history.data && !history.data.complete) ? (
        <p className="desktop-release-history-status">
          {history.data?.truncated ? 'Showing the latest 100 included releases.' : 'Some earlier release notes are unavailable.'}{' '}
          <a href="https://github.com/twentylines/orbis/releases" target="_blank" rel="noreferrer">
            Browse all releases on GitHub
          </a>
          .
        </p>
      ) : null}
      <div className="desktop-release-history-list">
        {groups.map((group) => {
          const primary = group.feature ?? group.revisions[0];
          if (!primary) return null;
          const revisions = group.feature ? group.revisions : group.revisions.slice(1);
          return (
            <ReleaseNote
              key={`${latest.tag}:${primary.tag}`}
              release={primary}
              expanded={Boolean(group.feature) || !hasFeature}
              alreadyInstalled={group.alreadyInstalled}
            >
              {revisions.length ? (
                <div className="desktop-release-revisions">
                  <h4>{group.feature ? 'Included updates' : 'Earlier included updates'}</h4>
                  {revisions.map((release) => (
                    <ReleaseNote key={release.tag} release={release} expanded={false} />
                  ))}
                </div>
              ) : null}
            </ReleaseNote>
          );
        })}
      </div>
    </section>
  );
}
