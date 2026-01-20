import { useMemo, useState } from "react";
import { useI18n } from "../i18n";

export type MultiSelectOption = {
  value: string;
  label: string;
  hint?: string;
  flag?: string;
  group?: string;
};

type MultiSelectProps = {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyMessage?: string;
  maxVisible?: number;
  listHeight?: number;
};

const normalize = (value: string) => value.toLowerCase().trim();

export default function MultiSelect({
  options,
  selected,
  onChange,
  placeholder,
  emptyMessage,
  maxVisible = 8,
  listHeight
}: MultiSelectProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const optionMap = useMemo(() => new Map(options.map((opt) => [opt.value, opt])), [options]);
  const hasGroups = useMemo(() => options.some((opt) => opt.group), [options]);

  const placeholderText = placeholder ?? t("multiSelect.placeholder");
  const emptyText = emptyMessage ?? t("multiSelect.empty");

  const filtered = useMemo(() => {
    const term = normalize(query);
    if (!term) return options.slice(0, maxVisible);
    return options
      .filter((opt) => {
        const bucket = [opt.label, opt.hint, opt.value].filter(Boolean).join(" ").toLowerCase();
        return bucket.includes(term);
      })
      .slice(0, maxVisible);
  }, [query, options, maxVisible]);

  const toggleValue = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selected.filter((item) => item !== value));
      return;
    }
    onChange([...selected, value]);
  };

  const removeValue = (value: string) => {
    onChange(selected.filter((item) => item !== value));
  };

  return (
    <div className="multi-select">
      <input
        className="multi-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholderText}
        aria-label={placeholderText}
      />
      <div className="multi-selected">
        {selected.length ? (
          selected.map((value) => {
            const option = optionMap.get(value);
            return (
              <span key={value} className="multi-chip">
                {option?.flag && <span className="flag">{option.flag}</span>}
                <span>{option?.label ?? value}</span>
                {option?.hint && <span className="muted"> - {option.hint}</span>}
                <button
                  type="button"
                  onClick={() => removeValue(value)}
                  aria-label={t("action.removeItem", { item: option?.label ?? value })}
                >
                  x
                </button>
              </span>
            );
          })
        ) : (
          <span className="muted">{t("multiSelect.emptySelection")}</span>
        )}
      </div>
      <div className="multi-list" style={listHeight ? { maxHeight: `${listHeight}px` } : undefined}>
        {filtered.length ? (
          (() => {
            const items: JSX.Element[] = [];
            let lastGroup = "";
            filtered.forEach((option, index) => {
              const group = option.group ?? "";
              if (hasGroups && group && group !== lastGroup) {
                items.push(
                  <div key={`group-${group}-${index}`} className="multi-group">
                    {group}
                  </div>
                );
                lastGroup = group;
              }
              items.push(
                <button
                  key={option.value}
                  type="button"
                  className={`multi-option ${selectedSet.has(option.value) ? "selected" : ""}`}
                  onClick={() => toggleValue(option.value)}
                >
                  <span>
                    {option.flag && <span className="flag">{option.flag}</span>}
                    {option.label}
                  </span>
                  {option.hint && <span className="muted">{option.hint}</span>}
                </button>
              );
            });
            return items;
          })()
        ) : (
          <span className="muted">{emptyText}</span>
        )}
      </div>
    </div>
  );
}
