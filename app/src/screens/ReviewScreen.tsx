import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FactReviewPanel, type FactReviewCommand } from '@/components/domain';
import { StandbyApiError, createStandbyBrowserApi } from '@/lib/standby-api';
import { useI18n } from '@/lib/i18n';
import { useStandbyWorkspaceStore, useReviewFlowStore } from '@/store';
import { cn } from '@/lib/utils';

function useReviewFlowState() {
  const caseId = useReviewFlowStore((state) => state.caseId);
  const facts = useReviewFlowStore((state) => state.facts);
  const normalizerArtifact = useReviewFlowStore((state) => state.normalizerArtifact);
  const mode = useReviewFlowStore((state) => state.mode);
  const setWorkspace = useStandbyWorkspaceStore((state) => state.setWorkspace);
  const clearReviewFlow = useReviewFlowStore((state) => state.clear);
  return { caseId, facts, normalizerArtifact, mode, setWorkspace, clearReviewFlow };
}

export function ReviewScreen() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<'IDLE' | 'VERIFYING' | 'FAILED'>('IDLE');
  const [message, setMessage] = useState<string | null>(null);
  const { caseId, facts, normalizerArtifact, mode, setWorkspace, clearReviewFlow } = useReviewFlowState();

  const completeReview = async (reviews: FactReviewCommand[]) => {
    const api = createStandbyBrowserApi();
    if (!api || !caseId) {
      setPhase('FAILED');
      setMessage(t('input.error.noCase'));
      return;
    }
    try {
      setPhase('VERIFYING');
      setMessage(t('input.status.verify'));
      const submittedReviews = import.meta.env.VITE_STANDBY_DEMO_MODE === 'ideal'
        ? reviews.map((review) => review.decision === 'REVIEWED'
          ? { ...review, source: 'CUSTOM' as const }
          : review)
        : reviews;
      await api.reviewFacts(caseId, submittedReviews);
      await api.freezeReviewSnapshot(caseId);
      const workspace = await api.getWorkspace(caseId);
      setWorkspace(caseId, workspace);
      clearReviewFlow();
      await navigate({ to: '/workspace' });
    } catch (error) {
      setPhase('FAILED');
      setMessage(
        error instanceof StandbyApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error ? error.message : t('input.error.review'),
      );
    }
  };

  if (!caseId || facts.length === 0) {
    return (
      <main className="mx-auto mt-16 max-w-5xl p-6 text-sm">
        <p>{t('input.error.noCase')}</p>
      </main>
    );
  }

  const isCustomMode = mode === 'CUSTOM';

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground lg:px-8">
      <div className="mx-auto max-w-[1500px]">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-medium">{t('review.title')}</h1>
          </div>
          {import.meta.env.VITE_STANDBY_DEMO_MODE !== 'ideal' && (
            <button
              type="button"
              onClick={() => void navigate({ to: '/review/mode' })}
              className="border border-border px-3 py-2 text-xs"
            >
              {t('review.changeMode')}
            </button>
          )}
        </div>

        <FactReviewPanel
          facts={facts}
          recommendations={normalizerArtifact?.payload.recommendations ?? []}
          normalizer={normalizerArtifact ? {
            authority: normalizerArtifact.authority,
            agentId: normalizerArtifact.agent_id,
            configId: normalizerArtifact.config_id,
          } : null}
          busy={phase === 'VERIFYING'}
          initialMode={isCustomMode ? 'CUSTOM' : 'RECOMMENDED'}
          onSubmit={(reviews) => void completeReview(reviews)}
        />

        {message && (
          <div className={cn(
            'mt-4 flex gap-3 border p-4',
            phase === 'FAILED' ? 'border-review bg-review-bg' : 'border-border bg-surface',
          )}
          >
            {phase === 'VERIFYING' ? (
              <LoaderCircle className="h-5 w-5 shrink-0 animate-spin" />
            ) : (
              <AlertTriangle className="h-5 w-5 shrink-0 text-review" />
            )}
            <div>
              <p className="mono text-[10px] text-muted-foreground">REVIEW</p>
              <p className="text-sm leading-6">{message}</p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
