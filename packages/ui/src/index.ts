/**
 * @formai/ui — the from-scratch component layer on top of the inherited
 * Sprout & Spark token system. Import tokens once via `@formai/ui/tokens.css`.
 *
 * Phase 0 ships the core primitives with keyboard/focus built in. Remaining
 * primitives (Tag, Avatar, Textarea, Select, Checkbox, Radio, Switch, Alert,
 * Toast, Tooltip, Tabs, Dialog) and the net-new components (DataGrid,
 * RepeatingGroup, SignaturePad, FileDropzone, DateTimePicker, CommandPalette,
 * ShortcutsOverlay) land in their respective feature phases.
 */

export { cn } from './utils/cn.js';
export { Icon, type IconProps } from './components/Icon.js';
export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from './components/Button.js';
export { IconButton, type IconButtonProps } from './components/IconButton.js';
export { Badge, type BadgeProps, type BadgeVariant } from './components/Badge.js';
export { Card, CardHeader, CardFooter, type CardProps } from './components/Card.js';
export { Divider, type DividerProps } from './components/Divider.js';
export { Input, type InputProps } from './components/Input.js';
export { Select, type SelectProps, type SelectOption } from './components/Select.js';
export { Avatar, type AvatarProps } from './components/Avatar.js';
export { Checkbox, type CheckboxProps } from './components/Checkbox.js';
export { Radio, type RadioProps } from './components/Radio.js';
export { Textarea, type TextareaProps } from './components/Textarea.js';
export { Switch, type SwitchProps } from './components/Switch.js';
export { Dialog, type DialogProps } from './components/Dialog.js';
export { ToastProvider, useToast, type ToastOptions, type ToastVariant } from './components/Toast.js';
export {
  DataGrid,
  type DataGridProps,
  type DataGridColumn,
} from './components/DataGrid.js';
export {
  RepeatingGroup,
  type RepeatingGroupProps,
  type RepeatingGroupColumn,
  type RepeatingGroupAnswerSet,
  type RepeatingRow,
} from './components/RepeatingGroup.js';
export { SignaturePad, type SignaturePadProps } from './components/SignaturePad.js';
export { FileDropzone, type FileDropzoneProps } from './components/FileDropzone.js';
export { DateTimePicker, type DateTimePickerProps } from './components/DateTimePicker.js';
