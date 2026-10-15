import { Markdown } from '@/components/markdown/markdown';
import { copilot } from '@uiw/codemirror-theme-copilot';
import ReactCodeMirror from '@uiw/react-codemirror';
import { AnimatePresence, motion } from 'framer-motion';
import { markdown } from '@codemirror/lang-markdown';
import { useDesktopPreferences } from '@/desktop/preferences';
import { appDescriptionText } from '../../helpers/app-description';

type Props = {
  meta: string;
  setMeta: (meta: string) => void;
  isEditing: boolean;
};

export const AppDescriptionEditor = ({ isEditing, meta, setMeta }: Props) => {
  const { preferences } = useDesktopPreferences();
  return (
    <AnimatePresence mode="wait">
      <motion.div key={isEditing ? 1 : 0} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {isEditing ? (
          <ReactCodeMirror
            placeholder="My app notes in markdown..."
            value={meta}
            height="400px"
            onChange={(e) => setMeta(e)}
            theme={preferences.mode === 'dark' ? copilot : 'light'}
            extensions={[markdown()]}
          />
        ) : (
          <Markdown content={appDescriptionText(meta)} className="markdown" />
        )}
      </motion.div>
    </AnimatePresence>
  );
};
