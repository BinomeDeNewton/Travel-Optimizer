import { useMemo, useState } from "react";

import type { MultiSelectOption } from "./MultiSelect";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "../lib/utils";
import { useI18n } from "../i18n";

type DestinationCountryPickerProps = {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  emptyMessage?: string;
  title?: string;
  subtitle?: string;
  searchPlaceholder?: string;
  emptyState?: string;
  maxVisible?: number;
};

const normalize = (value: string) => value.toLowerCase().trim();

const CheckIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="country-check-icon">
    <path
      d="M6.4 11.2 3.5 8.3l1.1-1.1 1.8 1.8 5-5 1.1 1.1-6.1 6.1Z"
      fill="currentColor"
    />
  </svg>
);

export default function DestinationCountryPicker({
  options,
  selected,
  onChange,
  placeholder,
  emptyMessage,
  title,
  subtitle,
  searchPlaceholder,
  emptyState,
  maxVisible
}: DestinationCountryPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const placeholderText = placeholder ?? t("picker.destinationCountries.placeholder");
  const emptyText = emptyMessage ?? t("picker.destinationCountries.empty");
  const titleText = title ?? t("picker.destinationCountries.title");
  const subtitleText = subtitle ?? t("picker.destinationCountries.subtitle");
  const searchPlaceholderText = searchPlaceholder ?? t("picker.destinationCountries.search");
  const emptyStateText = emptyState ?? t("picker.destinationCountries.emptyState");

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const optionMap = useMemo(() => new Map(options.map((opt) => [opt.value, opt])), [options]);

  const selectedOptions = useMemo(
    () =>
      selected.map((value) => optionMap.get(value) ?? { value, label: value }).filter((value) => value.label),
    [selected, optionMap]
  );

  const filteredOptions = useMemo(() => {
    const term = normalize(query);
    const filtered = term
      ? options.filter((option) => {
          const bucket = [option.label, option.hint, option.value, option.group].filter(Boolean).join(" ").toLowerCase();
          return bucket.includes(term);
        })
      : options;
    if (maxVisible && maxVisible > 0) {
      return filtered.slice(0, maxVisible);
    }
    return filtered;
  }, [options, query, maxVisible]);

  const grouped = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, MultiSelectOption[]>();
    filteredOptions.forEach((option) => {
      const group = option.group ?? t("label.other");
      if (!map.has(group)) {
        map.set(group, []);
        order.push(group);
      }
      map.get(group)?.push(option);
    });
    return { order, map };
  }, [filteredOptions, t]);

  const previewText = useMemo(() => {
    if (!selectedOptions.length) return placeholderText;
    const preview = selectedOptions.slice(0, 2).map((option) => option.label).join(", ");
    const extra = selectedOptions.length - 2;
    return extra > 0 ? `${preview} +${extra}` : preview;
  }, [selectedOptions, placeholderText]);

  const toggleValue = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selected.filter((item) => item !== value));
      return;
    }
    onChange([...selected, value]);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
    }
  };

  const handleClear = () => {
    onChange([]);
  };

  return (
    <div className="country-picker">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="country-picker-trigger">
            <span className="country-picker-text">{previewText}</span>
            <span className="country-picker-meta">
              <Badge variant="outline">{selectedOptions.length}</Badge>
              <span className="country-picker-caret">v</span>
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="country-picker-popover" align="start">
          <div className="country-picker-toolbar">
            <div>
              <h4>{titleText}</h4>
              <p className="muted">{subtitleText}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={handleClear} disabled={!selectedOptions.length}>
              {t("action.clear")}
            </Button>
          </div>
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={searchPlaceholderText}
              value={query}
              onValueChange={setQuery}
              autoFocus
            />
            <CommandList>
              {!filteredOptions.length ? (
                <CommandEmpty>{emptyText}</CommandEmpty>
              ) : (
                grouped.order.map((group) => (
                  <CommandGroup key={group} heading={group}>
                    {grouped.map.get(group)?.map((option) => {
                      const isSelected = selectedSet.has(option.value);
                      return (
                        <CommandItem
                          key={option.value}
                          value={`${option.label} ${option.hint ?? ""} ${option.group ?? ""}`}
                          onSelect={() => toggleValue(option.value)}
                          data-selected={isSelected}
                        >
                          <span className={cn("country-check", isSelected && "is-selected")}>
                            {isSelected ? <CheckIcon /> : null}
                          </span>
                          {option.flag && <span className="flag">{option.flag}</span>}
                          <span className="country-label">{option.label}</span>
                          {option.hint && <span className="country-hint">{option.hint}</span>}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ))
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div className="country-picker-chips">
        {selectedOptions.length ? (
          selectedOptions.map((option) => (
            <Badge key={option.value} variant="default" className="country-chip">
              {option.flag && <span className="flag">{option.flag}</span>}
              <span>{option.label}</span>
              {option.hint && <span className="muted">{option.hint}</span>}
              <button
                type="button"
                className="country-chip-remove"
                onClick={() => toggleValue(option.value)}
                aria-label={t("action.removeItem", { item: option.label })}
              >
                x
              </button>
            </Badge>
          ))
        ) : (
          <span className="muted">{emptyStateText}</span>
        )}
      </div>
    </div>
  );
}
