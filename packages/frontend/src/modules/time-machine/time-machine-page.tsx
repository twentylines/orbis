import { useNavigate } from 'react-router';
import { TimeMachineSettings } from './time-machine-settings';

export default function TimeMachinePage() {
  const navigate = useNavigate();
  return <TimeMachineSettings openTimeline onExitTimeline={() => void navigate('/settings?tab=time-machine')} />;
}
