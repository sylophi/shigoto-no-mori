interface ScriptFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}

export function ScriptField({ id, label, value, onChange }: ScriptFieldProps) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={value.includes("\n") ? 4 : 2}
        className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed transition-colors outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
    </div>
  );
}
