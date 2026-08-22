import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n';
import { useReviewFlowStore } from '@/store';

export function ReviewModeScreen() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const setMode = useReviewFlowStore((state) => state.setMode);
  const hasContext = useReviewFlowStore((state) =>
    Boolean(state.caseId) && state.facts.length > 0,
  );
  const demoMode = import.meta.env.VITE_STANDBY_DEMO_MODE === 'ideal';

  useEffect(() => {
    if (!demoMode || !hasContext) return;
    setMode('RECOMMENDED');
    void navigate({ to: '/review' });
  }, [demoMode, hasContext, navigate, setMode]);

  if (demoMode && hasContext) return null;

  if (!hasContext) {
    return (
      <main className="mx-auto mt-16 max-w-5xl p-6 text-sm">
        <p>{t('input.error.noCase')}</p>
      </main>
    );
  }

  const goToReview = (mode: 'RECOMMENDED' | 'CUSTOM') => {
    setMode(mode);
    void navigate({ to: '/review' });
  };

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground lg:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header>
          <h1 className="text-2xl font-medium">{t('review.modePageTitle')}</h1>
        </header>

        <section className="grid gap-4 md:grid-cols-2">
          <button
            type="button"
            className="border border-border bg-surface p-6 text-left transition hover:bg-muted"
            onClick={() => goToReview('RECOMMENDED')}
          >
            <span className="inline-flex border border-review bg-review-bg px-3 py-2 text-base text-review">
              {t('review.recommended')}
            </span>
          </button>

          <button
            type="button"
            className="border border-border bg-surface p-6 text-left transition hover:bg-muted"
            onClick={() => goToReview('CUSTOM')}
          >
            <span className="inline-flex border border-consistent bg-consistent-bg px-3 py-2 text-base text-consistent">
              {t('review.custom')}
            </span>
          </button>
        </section>
      </div>
    </main>
  );
}
