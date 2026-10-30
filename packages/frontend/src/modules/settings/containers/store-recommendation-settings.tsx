import { Switch } from '@/components/ui/Switch';
import { Button } from '@/components/ui/Button';
import type { StoreRecommendationCategory } from '@/modules/app/components/store-discover/store-recommendations';

export function StoreRecommendationSettings({
  shown,
  hidden,
  onChange,
  onRestore,
}: {
  shown: boolean;
  hidden: readonly StoreRecommendationCategory[];
  onChange: (shown: boolean) => void;
  onRestore: () => void;
}) {
  return (
    <section className="appearance-section" aria-labelledby="store-recommendations-heading">
      <div>
        <h2 id="store-recommendations-heading">Suggestions</h2>
      </div>
      <div className="appearance-material-controls">
        <Switch checked={shown} onCheckedChange={onChange} label="Show suggestions" />
        {hidden.length ? (
          <div className="appearance-actions">
            <Button type="button" variant="outline" onClick={onRestore}>
              Restore hidden categories
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
