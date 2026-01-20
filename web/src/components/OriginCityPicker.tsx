import { useMemo, useState } from "react";

import type { MultiSelectOption } from "./MultiSelect";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { cn } from "../lib/utils";
import { useI18n } from "../i18n";

type OriginCityPickerProps = {
  options: MultiSelectOption[];
  value: string | null;
  onChange: (next: string | null) => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  title?: string;
  subtitle?: string;
  badgeFallback?: string;
  searchPlaceholder?: string;
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

export default function OriginCityPicker({
  options,
  value,
  onChange,
  placeholder,
  emptyMessage,
  disabled = false,
  title,
  subtitle,
  badgeFallback,
  searchPlaceholder
}: OriginCityPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const placeholderText = placeholder ?? t("picker.originCity.placeholder");
  const emptyText = emptyMessage ?? t("picker.originCity.empty");
  const titleText = title ?? t("picker.originCity.title");
  const subtitleText = subtitle ?? t("picker.originCity.subtitle");
  const badgeFallbackText = badgeFallback ?? t("picker.originCity.badge");
  const searchPlaceholderText = searchPlaceholder ?? t("picker.originCity.search");

  const selectedOption = useMemo(() => {
    if (!value) return null;
    return options.find((option) => option.value === value || option.label === value) ?? {
      value,
      label: value
    };
  }, [options, value]);

  const filteredOptions = useMemo(() => {
    const term = normalize(query);
    if (!term) return options;
    return options.filter((option) => {
      const bucket = [option.label, option.hint, option.value, option.group].filter(Boolean).join(" ").toLowerCase();
      return bucket.includes(term);
    });
  }, [options, query]);

  const grouped = useMemo(() => {
    const order: string[] = [];
    const map = new Map<string, MultiSelectOption[]>();
    filteredOptions.forEach((option) => {
      const group = option.group ?? t("label.cities");
      if (!map.has(group)) {
        map.set(group, []);
        order.push(group);
      }
      map.get(group)?.push(option);
    });
    return { order, map };
  }, [filteredOptions, t]);

  const badgeLabel = selectedOption?.hint ? t("label.airports") : badgeFallbackText;

  const handleOpenChange = (nextOpen: boolean) => {
    if (disabled) {
      setOpen(false);
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery("");
    }
  };

  const handleSelect = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
    setQuery("");
  };

  const handleClear = () => {
    onChange(null);
  };

  return (
    <div className="origin-picker">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="origin-picker-trigger" disabled={disabled}>
            <span className="origin-picker-value">
              <span className={cn("origin-picker-label", !selectedOption && "is-placeholder")}>
                {selectedOption?.label ?? placeholderText}
              </span>
              {selectedOption?.hint && <span className="origin-picker-code">{selectedOption.hint}</span>}
            </span>
            <span className="origin-picker-meta">
              <Badge variant="outline">{badgeLabel}</Badge>
              <span className="country-picker-caret">v</span>
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="origin-picker-popover" align="start">
          <div className="origin-picker-toolbar">
            <div>
              <h4>{titleText}</h4>
              <p className="muted">{subtitleText}</p>
            </div>
            <Button variant="ghost" size="sm" onClick={handleClear} disabled={!selectedOption}>
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
                      const isSelected = option.value === selectedOption?.value;
                      return (
                        <CommandItem
                          key={option.value}
                          value={`${option.label} ${option.hint ?? ""}`}
                          onSelect={() => handleSelect(option.value)}
                          data-selected={isSelected}
                        >
                          <span className={cn("country-check", isSelected && "is-selected")}>
                            {isSelected ? <CheckIcon /> : null}
                          </span>
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
    </div>
  );
}
