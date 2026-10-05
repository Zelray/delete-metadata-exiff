import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';

/** The one text input. */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={`h-9 w-full rounded-md border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground/70 disabled:opacity-50 ${className}`}
        {...rest}
      />
    );
  },
);

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

interface SegmentedProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}

/** A calm segmented control (depth toggle, density, theme). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = '',
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex overflow-hidden rounded-md border border-border ${className}`}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`h-7 px-2.5 text-xs font-medium ${
              active
                ? 'bg-accent text-accent-foreground'
                : 'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel: string;
  onClick?: (event: React.MouseEvent) => void;
}

/** The one checkbox — used for card selection and toggles. */
export function Checkbox({ checked, onChange, ariaLabel, onClick }: CheckboxProps) {
  return (
    <input
      type="checkbox"
      role="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      onClick={(event) => {
        // Keep shift-click range selection working: the parent handles the
        // click; the checkbox must not swallow it.
        onClick?.(event);
      }}
      onChange={(event) => onChange(event.target.checked)}
      className="h-4 w-4 accent-[var(--accent)] cursor-pointer"
    />
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: string;
  id: string;
}

/** A labeled switch-style checkbox with an optional plain-English hint. */
export function Toggle({ checked, onChange, label, hint, id }: ToggleProps) {
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 accent-[var(--accent)] cursor-pointer"
      />
      <div className="text-sm leading-5">
        <label htmlFor={id} className="font-medium cursor-pointer">
          {label}
        </label>
        {hint !== undefined && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}
