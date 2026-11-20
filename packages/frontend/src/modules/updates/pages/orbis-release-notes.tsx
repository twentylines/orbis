import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DisclosureIndicator } from '@/components/ui/DisclosureIndicator/DisclosureIndicator';
import { useLocation } from 'react-router';
import { Markdown } from '@/components/markdown/markdown';
import { includedOrbisReleases, groupOrbisReleaseNotes, orbisReleaseHistoryOptions, type OrbisRelease } from '@/desktop/orbis-release';
import { useWindowVisible } from '@/desktop/window-visibility';
import type { OrbisReleaseChannel } from '@runtipi/common/schemas/orbis-release-channel';
import { formatOrbisVersion } from '@/desktop/orbis-version';
import './orbis-release-notes.css';

function ReleaseNote({ release, expanded, children }: { release: OrbisRelease; expanded: boolean; children?: ReactNode }) {
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? expanded;
  return (
    <details
      className="desktop-release-note"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) setChoice(event.currentTarget.open);
      }}
    >
      <summary>
        <span title={release.tag}>{formatOrbisVersion(release.tag)}</span>
        {release.publishedAt ? <time dateTime={release.publishedAt}>{new Date(release.publishedAt).toLocaleDateString()}</time> : null}
        <DisclosureIndicator />
      </summary>
      {open ? (
        <div className="desktop-release-note-content">
          {release.body ? (
            <Markdown
              content={release.body.trimStart().replace(/^#\s+Orbis[^\n]*\r?\n(?:\r?\n)*/i, '')}
              className="desktop-update-markdown"
              label={`${formatOrbisVersion(release.tag)} changelog`}
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

function IncludedNotes({ releases }: { releases: OrbisRelease[] }) {
  if (!releases.length) return null;
  return (
    <div className="desktop-release-revisions">
      <h4>Earlier included updates</h4>
      {releases.map((release) => (
        <ReleaseNote key={release.tag} release={release} expanded={false} />
      ))}
    </div>
  );
}

export function OrbisReleaseNotes({
  latest,
  installed,
  channel,
  compact = false,
}: {
  latest: OrbisRelease;
  installed: string | undefined;
  channel?: OrbisReleaseChannel;
  compact?: boolean;
}) {
  const titleId = useId();
  const visible = useWindowVisible();
  const entry = useLocation().key;
  const lastEntry = useRef(entry);
  const options = orbisReleaseHistoryOptions(installed, latest.tag, channel);
  const history = useQuery({ ...options, enabled: visible && options.enabled, staleTime: 60_000, refetchOnMount: 'always' });
  useEffect(() => {
    if (lastEntry.current === entry) return;
    lastEntry.current = entry;
    if (visible && options.enabled) void history.refetch();
  }, [entry, visible, options.enabled, history.refetch]);
  const releases = includedOrbisReleases(latest, installed, history.data?.releases);
  const groups = groupOrbisReleaseNotes(releases.filter((release) => release.tag !== latest.tag));
  const earlierUpdates = groups.filter((group) => !group.feature).flatMap((group) => group.revisions);
  const latestBody = latest.body ?? '';
  const showLatestNotes = !compact || (latestBody.length <= 800 && latestBody.split('\n').length <= 12);
  return (
    <section className="desktop-release-history" aria-labelledby={titleId}>
      <h3 id={titleId}>Changelog</h3>
      {options.enabled ? (
        <p className="desktop-release-history-intro">
          This update includes all changes since {formatOrbisVersion(installed ?? '')}, including any updates you skipped.
        </p>
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
        <ReleaseNote key={latest.tag} release={latest} expanded={showLatestNotes}>
          <IncludedNotes releases={earlierUpdates} />
        </ReleaseNote>
        {groups.map((group) =>
          group.feature ? (
            <ReleaseNote key={`${latest.tag}:${group.feature.tag}`} release={group.feature} expanded={!compact}>
              <IncludedNotes releases={group.revisions} />
            </ReleaseNote>
          ) : null,
        )}
      </div>
    </section>
  );
}
