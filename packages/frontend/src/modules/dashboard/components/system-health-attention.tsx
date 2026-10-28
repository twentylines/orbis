import { Link } from 'react-router';
import { useSystemHealth } from './use-system-health';

export function SystemHealthAttention() {
  const health = useSystemHealth();
  const active = Object.values(health).filter((condition) => condition.active);
  const temperatures = active.filter((condition) => condition.unit === '°C').sort((left, right) => right.value - left.value);
  const hottest = temperatures[0];
  if (!active.length) return null;
  return (
    <ul className="workspace-health-attention">
      {active
        .filter((condition) => condition.unit === '%')
        .map((condition) => (
          <li key={condition.id}>
            <Link to={condition.href}>
              <strong>{condition.label} needs attention</strong>
              <span>
                {condition.value.toFixed(1)}
                {condition.unit} ·{' '}
                {condition.fresh ? (condition.value >= condition.threshold ? 'Sustained high use' : 'Waiting for recovery') : 'Readings delayed'}
              </span>
            </Link>
          </li>
        ))}
      {hottest ? (
        <li>
          <Link to={hottest.href}>
            <strong>Hardware temperature alert</strong>
            <span>
              {hottest.label}: {hottest.value.toFixed(1)} °C
              {temperatures.length > 1 ? ` · ${temperatures.length} sensors` : ''}
              {temperatures.some((condition) => !condition.fresh)
                ? ' · Readings delayed'
                : temperatures.some((condition) => condition.value >= condition.threshold)
                  ? ' · Sustained high reading'
                  : ' · Waiting for recovery'}
            </span>
          </Link>
        </li>
      ) : null}
    </ul>
  );
}
