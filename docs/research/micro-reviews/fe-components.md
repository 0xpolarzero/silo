# Frontend component micro-review

Scope: `app/SiloUI/src/components/`, correctness and accessibility defects.

Read-only source review. Checked the first review, second review, and all `docs/SiloUI-CODE-REVIEW-PASS-3-*.md` reports for these components and findings; none was already reported. No builds, tests, native launches, or live-data checks were run, as required by `/tmp/silo-micro.md`.

## FE-COMPONENTS-1 — P2 — Confirmation and form dialogs have no accessible name

- **File:line:** `app/SiloUI/src/components/confirm-popover.tsx:84`, with title rendering at lines 111 and 138; `app/SiloUI/src/components/ui/popover.tsx:23`.
- **Trigger:** Open a `ConfirmPopover` or `FormPopover`, including the sandbox deletion confirmation in `features/sandboxes/components/machine-list.tsx:357`.
- **Evidence:** `Shell` renders `PopoverContent` without `aria-label` or `aria-labelledby`. Both bodies render their title as a plain paragraph without an ID. The shared wrapper forwards to Radix Content without supplying a name. The installed Radix implementation in the main checkout, `app/SiloUI/node_modules/@radix-ui/react-popover/dist/index.js:293–296`, sets `role: "dialog"` but supplies no label automatically. Existing component tests check visible titles and button focus, not the dialog's accessible name.
- **Consequence:** The dialog exposes an empty accessible name when focus enters it. Screen reader users do not receive the operation or target as the dialog name, including for destructive confirmations.
- **Suggested fix:** Generate a unique title ID, pass it to the body title and `PopoverContent`'s `aria-labelledby`, and associate the description with `aria-describedby` when present. Preserve the existing focus behavior.
- **Test that would catch it:** Open both kinds of popover and assert `getByRole("dialog", { name: "Delete it?" })` or the form title. Assert the accessible description when provided, and render two instances to check distinct title IDs.

## FE-COMPONENTS-2 — P2 — Arrow navigation selects filter options outside the visible viewport

- **File:line:** `app/SiloUI/src/components/filter-combobox.tsx:95–105`, with the scroll container at line 120 and option rendering at lines 127–140.
- **Trigger:** Open a filter containing enough results to overflow its capped height and press ArrowDown until the active option is below the visible list. The secret editor supplies the full sandbox list at `features/application/components/secret-editor.tsx:86–95`, so this is a supported input.
- **Evidence:** The input keeps DOM focus, suppresses the default arrow behavior, and changes only `activeIndex`. That changes `aria-activedescendant`, `aria-selected`, and the highlight class. Neither this component nor its generic Popover wrapper scrolls the active option into view or focuses it. The list uses `overflow-y-auto` and a maximum height of 15rem or the available viewport height. Enter still adds `results[activeIndex]`.
- **Consequence:** A sighted keyboard user loses the visible selection after reaching the viewport edge and can select an unseen sandbox or filter with Enter.
- **Suggested fix:** Keep a reference to the active option and scroll it into view with nearest alignment whenever keyboard navigation changes the active option, while retaining input focus.
- **Test that would catch it:** In a browser fixture with at least 30 options and a short viewport, navigate below and above the list's visible bounds. Assert the active option's bounding rectangle remains inside the scroll container, input focus remains intact, and Enter selects the visibly highlighted value.

## FE-COMPONENTS-3 — P3 — Operation step status is available only visually

- **File:line:** `app/SiloUI/src/components/operation-toast-body.tsx:44–48` and `87–90`.
- **Trigger:** Inspect the step list in a running checkpoint restore or sandbox transfer with a screen reader. Production callers supply per-step states at `features/application/model/checkpoint-operation-toast.ts:46–60` and `features/application/components/computer-transfer.tsx:130`.
- **Evidence:** Every status icon is `aria-hidden`. Each list item exposes only its label; state is stored in `data-state` and represented through the icon and colors. There is no accessible state text or `aria-current`. The existing toast test checks the list item count, not its exposed states.
- **Consequence:** Completed, current, pending, and failed steps cannot be distinguished through the step list's accessible content. The separate current-step line does not convey each preceding or pending step's status.
- **Suggested fix:** Include visually hidden status text for every step and mark the current step with `aria-current="step"`.
- **Test that would catch it:** Render one step in each state and assert each list item exposes both its label and status to assistive technology, with exactly the current step carrying `aria-current="step"`.
