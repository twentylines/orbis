import { Markdown } from '@/components/markdown/markdown';
import { CodeEditor } from '@/components/code-editor/code-editor';
import { AnimatePresence, motion } from 'framer-motion';
import { markdown } from '@codemirror/lang-markdown';
import { appDescriptionText } from '../../helpers/app-description';

type Props = {
  meta: string;
  setMeta: (meta: string) => void;
  isEditing: boolean;
};
const markdownExtensions = [markdown()];

export const AppDescriptionEditor = ({ isEditing, meta, setMeta }: Props) => {
  return (
    <AnimatePresence mode="wait">
      <motion.div key={isEditing ? 1 : 0} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        {isEditing ? (
          <CodeEditor
            label="App notes"
            placeholder="My app notes in markdown..."
            value={meta}
            height="400px"
            onChange={setMeta}
            extensions={markdownExtensions}
          />
        ) : (
          <Markdown content={appDescriptionText(meta)} className="markdown" />
        )}
      </motion.div>
    </AnimatePresence>
  );
};
