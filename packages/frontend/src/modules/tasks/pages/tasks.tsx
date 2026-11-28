import { useSearchParams } from 'react-router';
import { useLayoutEffect, useRef } from 'react';
import { useTasks } from '@/desktop/tasks';
import { useTimeMachineActivity } from '@/modules/time-machine/use-time-machine-activity';
import { useAppContext } from '@/context/app-context';
import { useRestoreRequests } from '@/modules/host-transfer/receiver-request-context';
import { useTaskCentreRecords } from '@/desktop/task-centre-records';
import { useSystemTaskActivity } from '@/desktop/use-system-task-activity';
import { DesktopTaskPanel } from '@/desktop/desktop-task-panel';
import './tasks.css';

export default function Tasks() {
  const { user } = useAppContext();
  const tasks = useTasks();
  const captures = useTimeMachineActivity();
  const requests = useRestoreRequests();
  const [params, setParams] = useSearchParams();
  const requestedApp = params.get('app');
  const appScope = requestedApp && requestedApp.length <= 180 && /^[^:]+:[^:]+$/.test(requestedApp) ? requestedApp : null;
  const page = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = page.current;
    const heading = element?.querySelector<HTMLElement>('.task-centre-heading');
    const scope = appScope ? element?.querySelector<HTMLElement>('.task-scope') : null;
    if (!element || !heading) return;
    const measure = () => {
      const scopeSpace = scope ? scope.getBoundingClientRect().height + Number.parseFloat(getComputedStyle(scope).marginBlockEnd) : 0;
      element.style.setProperty('--task-centre-page-heading-space', `${heading.getBoundingClientRect().height + scopeSpace}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(heading);
    if (scope) observer.observe(scope);
    return () => observer.disconnect();
  }, [appScope]);
  const systemActivity = useSystemTaskActivity(!appScope, 'page');
  const serverRecords = tasks.data?.tasks ?? [];
  const centre = useTaskCentreRecords(serverRecords, user.id);
  const records = centre.records.filter((task) => !appScope || task.appUrn === appScope);
  return (
    <div className="task-centre-page" ref={page}>
      {appScope ? (
        <div className="task-scope">
          <span>
            Application: <strong>{centre.names.get(appScope) ?? appScope}</strong>
          </span>
          <button
            type="button"
            onClick={() =>
              setParams((previous) => {
                const next = new URLSearchParams(previous);
                next.delete('app');
                return next;
              })
            }
          >
            Show all applications
          </button>
        </div>
      ) : null}
      <DesktopTaskPanel
        visibilityOwner={String(user.id)}
        key={appScope ?? 'all'}
        surface="page"
        initialSource={appScope ?? 'all'}
        tasks={records}
        names={centre.names}
        dismissSetupFailure={centre.dismiss}
        restoreRequests={appScope ? undefined : requests}
        systemActivity={appScope ? undefined : systemActivity}
        loading={tasks.isPending}
        failed={tasks.isError}
        storageUnavailable={tasks.data?.storage === 'unavailable'}
        capture={!appScope && captures.activity ? captures.data?.point : null}
        captureFailed={!appScope && user.operator === true && captures.isError}
        pendingRequests={appScope ? 0 : (requests?.pendingCount ?? 0)}
        criticalUpdate={false}
        retry={() => tasks.refetch({ cancelRefetch: false })}
        retryCapture={() => captures.refetch({ cancelRefetch: false })}
        close={() => undefined}
      />
    </div>
  );
}
