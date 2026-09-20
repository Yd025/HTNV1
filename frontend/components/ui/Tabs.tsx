import {
  useRef,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  /** A stable, unique prefix shared with this tab list's TabPanel components. */
  id: string;
  label: string;
  value: T;
  onValueChange: (value: T) => void;
  items: readonly TabItem<T>[];
  className?: string;
  variant?: "line" | "pill";
  orientation?: "horizontal" | "vertical";
}

function tabId(id: string, value: string) {
  return `${id}-tab-${encodeURIComponent(value)}`;
}

function panelId(id: string, value: string) {
  return `${id}-panel-${encodeURIComponent(value)}`;
}

/** Controlled tabs with automatic activation and a single roving tab stop. */
export function Tabs<T extends string>({
  id,
  label,
  value,
  onValueChange,
  items,
  className = "",
  variant = "line",
  orientation = "horizontal",
}: TabsProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  const enabledItems = items.filter((item) => !item.disabled);
  const activeValue = enabledItems.some((item) => item.value === value)
    ? value
    : enabledItems[0]?.value;

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentValue: T,
  ) {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      enabledItems.length === 0
    )
      return;
    const index = enabledItems.findIndex((item) => item.value === currentValue);
    const previous = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const next = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    let nextIndex: number;

    switch (event.key) {
      case previous:
        nextIndex = (index - 1 + enabledItems.length) % enabledItems.length;
        break;
      case next:
        nextIndex = (index + 1) % enabledItems.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = enabledItems.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextValue = enabledItems[nextIndex].value;
    buttons.current.get(nextValue)?.focus();
    onValueChange(nextValue);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation={orientation}
      className={`ui-tabs ui-tabs--${variant} ${className}`.trim()}
    >
      {items.map((item) => {
        const selected = activeValue === item.value;
        return (
          <button
            key={item.value}
            ref={(element) => {
              if (element) buttons.current.set(item.value, element);
              else buttons.current.delete(item.value);
            }}
            type="button"
            role="tab"
            id={tabId(id, item.value)}
            aria-controls={selected ? panelId(id, item.value) : undefined}
            aria-selected={selected}
            disabled={item.disabled}
            tabIndex={selected ? 0 : -1}
            className="ui-tab"
            data-state={selected ? "active" : "inactive"}
            data-value={item.value}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => handleKeyDown(event, item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps<T extends string> extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "id"
> {
  id: string;
  value: T;
  activeValue: T;
  /** Keep expensive or stateful content mounted when switching away. */
  keepMounted?: boolean;
}

/** Render one per tab so aria-controls always resolves, including inactive tabs. */
export function TabPanel<T extends string>({
  id,
  value,
  activeValue,
  keepMounted = false,
  className = "",
  children,
  ...props
}: TabPanelProps<T>) {
  const selected = value === activeValue;
  return (
    <div
      {...props}
      role="tabpanel"
      id={panelId(id, value)}
      aria-labelledby={tabId(id, value)}
      hidden={!selected}
      tabIndex={0}
      className={`ui-tab-panel ${className}`.trim()}
      data-state={selected ? "active" : "inactive"}
    >
      {selected || keepMounted ? children : null}
    </div>
  );
}

export default Tabs;
