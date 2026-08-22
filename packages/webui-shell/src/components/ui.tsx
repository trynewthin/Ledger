import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'

/** shadcn/ui 风格的极小组件集（手写实现，Tailwind 原子类） */

const variants: Record<string, string> = {
  default: 'bg-zinc-900 text-zinc-50 hover:bg-zinc-800',
  outline: 'border border-zinc-200 bg-white hover:bg-zinc-100 text-zinc-900',
  ghost: 'hover:bg-zinc-100 text-zinc-900',
  destructive: 'bg-red-600 text-white hover:bg-red-500',
}

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'destructive' }) {
  return (
    <button
      className={`inline-flex h-9 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 ${variants[variant]} ${className}`}
      {...props}
    />
  )
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-sm ${className}`}>{children}</div>
}

export function CardHeader({ children }: { children: ReactNode }) {
  return <div className="flex flex-col space-y-1.5 p-6">{children}</div>
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-semibold leading-none tracking-tight">{children}</h3>
}

export function CardContent({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`p-6 pt-0 ${className}`}>{children}</div>
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`flex h-9 w-full rounded-md border border-zinc-200 bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 ${className}`}
      {...props}
    />
  )
}

export function Label({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="text-sm font-medium leading-none text-zinc-700">
      {children}
    </label>
  )
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`flex h-9 w-full rounded-md border border-zinc-200 bg-white px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-zinc-400 ${className}`}
      {...props}
    >
      {children}
    </select>
  )
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'success' | 'warn' | 'danger' }) {
  const tones: Record<string, string> = {
    default: 'bg-zinc-100 text-zinc-800',
    success: 'bg-emerald-100 text-emerald-800',
    warn: 'bg-amber-100 text-amber-800',
    danger: 'bg-red-100 text-red-800',
  }
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
}
