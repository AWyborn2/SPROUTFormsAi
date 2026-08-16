import { useEffect, useState } from 'react';
import { Button, Icon } from '@formai/ui';

export interface TheoryResultsProps {
  correctCount: number;
  totalCount: number;
  passPercent: number;
  outcome?: string;
  partLabel: string;
  onTryAgain: () => void;
  onBack: () => void;
}

/**
 * Animated results screen shown after completing a theory quiz.
 *
 * Shows an animated circular gauge with the score percentage, a pass/fail
 * indicator, and action buttons.
 */
export function TheoryResults({
  correctCount,
  totalCount,
  passPercent,
  outcome,
  partLabel,
  onTryAgain,
  onBack,
}: TheoryResultsProps) {
  const percentage = totalCount > 0 ? Math.round((correctCount / totalCount) * 100) : 0;
  const passed = outcome === 'satisfactory';

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const [animatedPercent, setAnimatedPercent] = useState(prefersReducedMotion ? percentage : 0);
  const [showResult, setShowResult] = useState(prefersReducedMotion);

  useEffect(() => {
    if (prefersReducedMotion) {
      setAnimatedPercent(percentage);
      setShowResult(true);
      return;
    }
    const duration = 1200;
    const steps = 60;
    const increment = percentage / steps;
    let step = 0;

    const timer = setInterval(() => {
      step++;
      setAnimatedPercent(Math.min(percentage, Math.round(increment * step)));
      if (step >= steps) {
        clearInterval(timer);
        setAnimatedPercent(percentage);
        setTimeout(() => setShowResult(true), 300);
      }
    }, duration / steps);

    return () => clearInterval(timer);
  }, [percentage, prefersReducedMotion]);

  // SVG circle dimensions
  const size = 220;
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (animatedPercent / 100) * circumference;

  // The pass threshold marker position
  const passAngle = (passPercent / 100) * 360 - 90;
  const passMarkerX = size / 2 + radius * Math.cos((passAngle * Math.PI) / 180);
  const passMarkerY = size / 2 + radius * Math.sin((passAngle * Math.PI) / 180);

  return (
    <div className="fai-rise mx-auto flex max-w-[680px] flex-col items-center p-[30px_28px_60px]">
      <hr className="mb-8 w-full border-border" />

      <h2 className="font-heading text-[24px] font-semibold text-text-secondary">
        Quiz Results
      </h2>

      <div className="relative mt-8 mb-2">
        <svg width={size} height={size} className="rotate-[-90deg]">
          {/* Background circle */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="var(--surface-sunken)"
            strokeWidth={strokeWidth}
          />
          {/* Animated score arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={passed ? 'var(--success, oklch(0.65 0.16 145))' : 'var(--danger, oklch(0.65 0.22 25))'}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            className="transition-[stroke-dashoffset] duration-100"
          />
          {/* Pass threshold marker */}
          <circle
            cx={passMarkerX}
            cy={passMarkerY}
            r={5}
            fill="var(--text-primary)"
          />
        </svg>

        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <p className="font-heading text-[36px] font-bold text-text-primary">
            {animatedPercent}%
          </p>
          <div
            className={`mt-1 flex items-center gap-1.5 transition-all ${
              prefersReducedMotion ? '' : 'duration-500'
            } ${showResult ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}`}
          >
            <div
              className={`flex h-6 w-6 items-center justify-center rounded-full ${
                passed ? 'bg-[var(--success)]' : 'bg-[var(--danger)]'
              } text-white`}
            >
              <Icon name={passed ? 'check' : 'x'} size={14} />
            </div>
            <span className={`text-[13px] font-semibold ${
              passed ? 'text-[var(--success)]' : 'text-[var(--danger)]'
            }`}>
              {passed ? 'Passed' : 'Not passed'}
            </span>
          </div>
        </div>

        {/* Pass threshold label */}
        <div
          className="absolute text-[11px] font-semibold uppercase tracking-wider"
          style={{
            right: '-40px',
            bottom: `${size / 2 - 30}px`,
          }}
        >
          <div className="text-text-tertiary">Passing</div>
          <div className="text-accent">{passPercent}%</div>
        </div>
      </div>

      <p className="mt-4 text-[13px] text-text-secondary">
        {passed
          ? `Well done — you scored ${percentage}% on ${partLabel}.`
          : `You scored ${percentage}% on ${partLabel}. ${passPercent}% is required to pass.`}
      </p>
      <p className="mt-1 text-[12px] text-text-tertiary">
        {correctCount} of {totalCount} questions correct
      </p>

      <div className="mt-8 flex items-center gap-3">
        {passed ? (
          <Button leadingIcon="arrow-left" onClick={onBack}>
            Back to case
          </Button>
        ) : (
          <>
            <Button leadingIcon="rotate-ccw" onClick={onTryAgain}>
              Take again
            </Button>
            <Button variant="outline" onClick={onBack}>
              Back to case
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
