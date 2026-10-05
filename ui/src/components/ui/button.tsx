import { forwardRef, type ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-40',
  secondary:
    'bg-muted text-foreground hover:bg-accent-soft disabled:opacity-40',
  ghost:
    'bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40',
  danger:
    'bg-destructive text-white hover:opacity-90 disabled:opacity-40',
  outline:
    'border border-border bg-transparent text-foreground hover:bg-muted disabled:opacity-40',
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
};

/** The one button. Calm by default; color only where it means something. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className = '', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-none select-none disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...rest}
    />
  );
});
