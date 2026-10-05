import { useState } from 'react';
import type { FieldKey, StagedEdits } from './fields';
import { FIELD_DEFS, TIMEZONES, dateNoteFor } from './fields';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Input } from '../components/ui/controls';
import { ConfirmDialog } from '../components/ConfirmDialog';

/** Current values shown as captions when they are known (single file). */
export interface CurrentValues {
  title?: string;
  description?: string;
  keywords: string[];
  rating?: number;
  dateTaken?: string;
  copyright?: string;
  creator?: string;
}

export interface EditFieldsProps {
  staged: StagedEdits;
  onChange: (next: StagedEdits) => void;
  /** Known current values (single-file edit); omit for batches. */
  current?: CurrentValues;
  /** Multi-file honesty note, e.g. "current values may differ per file". */
  scopeNote?: string;
  /** The date field is Edit-only; Batch swaps it for the shift tool. */
  showDateTaken?: boolean;
}

/**
 * The friendly field form, shared by the Edit Panel and the Batch panel
 * (ux-spec: single source of truth). Safety semantics are structural, not
 * advisory: every control starts EMPTY and empty produces no edit; deletion
 * is a separate red action per field with its own confirmation.
 */
export function EditFields({ staged, onChange, current, scopeNote, showDateTaken = true }: EditFieldsProps) {
  const [confirmDelete, setConfirmDelete] = useState<FieldKey | null>(null);
  const [keywordDraft, setKeywordDraft] = useState('');

  const set = (patch: Partial<StagedEdits>): void => onChange({ ...staged, ...patch });

  const armDelete = (key: FieldKey): void =>
    setConfirmDelete(key);

  const setValue = (key: FieldKey, value: string): void => {
    // Entering a value disarms that field's pending delete (never both).
    const deletes = staged.deletes.filter((d) => d !== key);
    switch (key) {
      case 'title':
        return set({ title: value, deletes });
      case 'description':
        return set({ description: value, deletes });
      case 'rating':
        return set({ rating: value, deletes });
      case 'dateTaken':
        return set({ dateTaken: value, deletes });
      case 'copyright':
        return set({ copyright: value, deletes });
      case 'creator':
        return set({ creator: value, deletes });
      default:
        return;
    }
  };

  const currentValueOf = (key: FieldKey): string | undefined => {
    if (current === undefined) return undefined;
    switch (key) {
      case 'title':
        return current.title;
      case 'description':
        return current.description;
      case 'keywords':
        return current.keywords.length > 0 ? current.keywords.join(', ') : undefined;
      case 'rating':
        return current.rating !== undefined ? `${current.rating} of 5` : undefined;
      case 'dateTaken':
        return current.dateTaken;
      case 'copyright':
        return current.copyright;
      case 'creator':
        return current.creator;
      default:
        return undefined;
    }
  };

  const addKeyword = (): void => {
    const word = keywordDraft.trim();
    if (word === '') return;
    if (staged.addKeywords.some((k) => k.toLowerCase() === word.toLowerCase())) return;
    // A keyword both added and removed cancels out in the tray.
    const removeKeywords = staged.removeKeywords.filter((k) => k.toLowerCase() !== word.toLowerCase());
    setKeywordDraft('');
    set({ addKeywords: [...staged.addKeywords, word], removeKeywords, deletes: staged.deletes.filter((d) => d !== 'keywords') });
  };

  const removeExistingKeyword = (word: string): void => {
    if (staged.removeKeywords.some((k) => k.toLowerCase() === word.toLowerCase())) return;
    const addKeywords = staged.addKeywords.filter((k) => k.toLowerCase() !== word.toLowerCase());
    set({ removeKeywords: [...staged.removeKeywords, word], addKeywords, deletes: staged.deletes.filter((d) => d !== 'keywords') });
  };

  const deleteArmed = (key: FieldKey): boolean => staged.deletes.includes(key);
  const keywordsDirty = staged.addKeywords.length > 0 || staged.removeKeywords.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className="tip inline-flex"
          title="MWG is the metadata working group's cross-file recipe: one write updates the matching XMP, EXIF, and IPTC fields together so every app agrees."
        >
          <Badge tone="info">MWG sync ON</Badge>
          <span className="tip-body">
            Sync ON — writes matching EXIF/IPTC/XMP fields together so every app agrees.
          </span>
        </span>
        <span
          className="tip inline-flex"
          title="The server always writes with exiftool's -P flag: the file's Windows modified time is preserved on every write."
        >
          <Badge tone="neutral">Keeps file's modified date</Badge>
          <span className="tip-body">
            Always on (-P). The photo's date taken is separate and is only changed when you edit it.
          </span>
        </span>
        {scopeNote !== undefined && <span className="text-muted-foreground">{scopeNote}</span>}
      </div>

      <FieldRow
        defKey="title"
        value={staged.title}
        current={currentValueOf('title')}
        deleteArmed={deleteArmed('title')}
        onValue={(v) => setValue('title', v)}
        onDelete={() => armDelete('title')}
      />

      <FieldRow
        defKey="description"
        value={staged.description}
        current={currentValueOf('description')}
        deleteArmed={deleteArmed('description')}
        onValue={(v) => setValue('description', v)}
        onDelete={() => armDelete('description')}
        multiline
      />

      {/* Keywords: chips + add/remove (existing chips removable only when known) */}
      <section className="rounded-lg border border-border px-3 py-3">
        <FieldHeader defKey="keywords" current={currentValueOf('keywords')} deleteArmed={deleteArmed('keywords')} onDelete={() => armDelete('keywords')} deleteDisabled={keywordsDirty} />
        {current !== undefined && current.keywords.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Now:</span>
            {current.keywords.map((keyword) => {
              const marked = staged.removeKeywords.some((k) => k.toLowerCase() === keyword.toLowerCase());
              return (
                <span
                  key={keyword}
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${
                    marked ? 'border-destructive/50 text-destructive line-through' : 'border-border'
                  }`}
                >
                  {keyword}
                  {!marked && (
                    <button
                      type="button"
                      aria-label={`Remove keyword ${keyword}`}
                      title="Remove just this keyword"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeExistingKeyword(keyword)}
                    >
                      ×
                    </button>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {staged.addKeywords.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-accent">Adding:</span>
            {staged.addKeywords.map((keyword) => (
              <span key={keyword} className="inline-flex items-center gap-1 rounded border border-accent/40 px-1.5 py-0.5 text-xs text-accent">
                {keyword}
                <button
                  type="button"
                  aria-label={`Cancel adding keyword ${keyword}`}
                  className="hover:text-destructive"
                  onClick={() => set({ addKeywords: staged.addKeywords.filter((k) => k !== keyword) })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {staged.removeKeywords.length > 0 && (
          <div className="mb-2 text-xs text-destructive">
            Removing: {staged.removeKeywords.join(', ')}{' '}
            <button type="button" className="underline" onClick={() => set({ removeKeywords: [] })}>
              cancel
            </button>
          </div>
        )}
        <div className="flex gap-2">
          <Input
            value={keywordDraft}
            onChange={(event) => setKeywordDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                addKeyword();
              }
            }}
            placeholder={FIELD_DEFS.keywords.placeholder}
            aria-label="Add a keyword"
            className="h-8 text-xs"
          />
          <Button size="sm" variant="outline" onClick={addKeyword} disabled={keywordDraft.trim() === ''}>
            Add keyword
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{FIELD_DEFS.keywords.hint}</p>
      </section>

      {/* Rating: stars */}
      <section className="rounded-lg border border-border px-3 py-3">
        <FieldHeader defKey="rating" current={currentValueOf('rating')} deleteArmed={deleteArmed('rating')} onDelete={() => armDelete('rating')} deleteDisabled={staged.rating !== ''} />
        <div className="flex items-center gap-1" role="group" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}
              aria-pressed={staged.rating === String(star)}
              title={`${star} star${star === 1 ? '' : 's'}`}
              onClick={() => setValue('rating', staged.rating === String(star) ? '' : String(star))}
              className={`text-lg leading-none ${staged.rating !== '' && Number(staged.rating) >= star ? 'text-warning' : 'text-muted-foreground/50 hover:text-muted-foreground'}`}
            >
              {staged.rating !== '' && Number(staged.rating) >= star ? '★' : '☆'}
            </button>
          ))}
          {staged.rating !== '' && (
            <Button size="sm" variant="ghost" onClick={() => setValue('rating', '')}>
              clear
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{FIELD_DEFS.rating.hint}</p>
      </section>

      {showDateTaken && (
        <section className="rounded-lg border border-border px-3 py-3">
          <FieldHeader defKey="dateTaken" current={currentValueOf('dateTaken')} deleteArmed={deleteArmed('dateTaken')} onDelete={() => armDelete('dateTaken')} deleteDisabled={staged.dateTaken !== ''} />
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="datetime-local"
              value={staged.dateTaken}
              onChange={(event) => setValue('dateTaken', event.target.value)}
              aria-label="Date taken"
              className="h-8 w-56 text-xs"
            />
            <select
              value={staged.timezone}
              onChange={(event) => set({ timezone: event.target.value })}
              aria-label="Timezone for the date"
              className="h-8 rounded-md border border-input bg-card px-2 text-xs"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.id} value={tz.id}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {staged.timezone !== 'none' || staged.dateTaken !== '' ? dateNoteFor(staged.timezone) : FIELD_DEFS.dateTaken.hint}
          </p>
        </section>
      )}

      <FieldRow
        defKey="copyright"
        value={staged.copyright}
        current={currentValueOf('copyright')}
        deleteArmed={deleteArmed('copyright')}
        onValue={(v) => setValue('copyright', v)}
        onDelete={() => armDelete('copyright')}
      />

      <FieldRow
        defKey="creator"
        value={staged.creator}
        current={currentValueOf('creator')}
        deleteArmed={deleteArmed('creator')}
        onValue={(v) => setValue('creator', v)}
        onDelete={() => armDelete('creator')}
      />

      <ConfirmDialog
        open={confirmDelete !== null}
        danger
        title={confirmDelete !== null ? FIELD_DEFS[confirmDelete].deleteLabel : ''}
        confirmLabel="Delete this field"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete === null) return;
          const key = confirmDelete;
          setConfirmDelete(null);
          // Arming a delete clears any staged value for that field: the two
          // actions are mutually exclusive by construction.
          const patch: Partial<StagedEdits> = { deletes: [...staged.deletes, key] };
          if (key === 'title') patch.title = '';
          if (key === 'description') patch.description = '';
          if (key === 'keywords') patch.addKeywords = [];
          if (key === 'rating') patch.rating = '';
          if (key === 'dateTaken') patch.dateTaken = '';
          if (key === 'copyright') patch.copyright = '';
          if (key === 'creator') patch.creator = '';
          set(patch);
        }}
      >
        <p>
          This writes an explicit delete for {confirmDelete !== null ? FIELD_DEFS[confirmDelete].tags.join(', ') : ''} on
          every selected file. Empty fields never delete anything — this separate red action is the
          only way a tag is removed.
        </p>
      </ConfirmDialog>
    </div>
  );
}

function FieldRow({
  defKey,
  value,
  current,
  deleteArmed,
  onValue,
  onDelete,
  multiline = false,
}: {
  defKey: FieldKey;
  value: string;
  current?: string;
  deleteArmed: boolean;
  onValue: (v: string) => void;
  onDelete: () => void;
  multiline?: boolean;
}) {
  const def = FIELD_DEFS[defKey];
  return (
    <section className={`rounded-lg border px-3 py-3 ${deleteArmed ? 'border-destructive/60 bg-destructive/5' : 'border-border'}`}>
      <FieldHeader defKey={defKey} current={current} deleteArmed={deleteArmed} onDelete={onDelete} deleteDisabled={value.trim() !== ''} />
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onValue(event.target.value)}
          placeholder={def.placeholder}
          aria-label={def.label}
          rows={3}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm placeholder:text-muted-foreground/70"
        />
      ) : (
        <Input
          value={value}
          onChange={(event) => onValue(event.target.value)}
          placeholder={def.placeholder}
          aria-label={def.label}
          className="h-8 text-sm"
        />
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">{def.hint}</p>
    </section>
  );
}

function FieldHeader({
  defKey,
  current,
  deleteArmed,
  onDelete,
  deleteDisabled,
}: {
  defKey: FieldKey;
  current?: string;
  deleteArmed: boolean;
  onDelete: () => void;
  deleteDisabled: boolean;
}) {
  const def = FIELD_DEFS[defKey];
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-sm font-medium">{def.label}</span>
      {deleteArmed && <Badge tone="danger">delete armed</Badge>}
      {current !== undefined && current !== '' && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={current}>
          now: {current}
        </span>
      )}
      <Button
        size="sm"
        variant="outline"
        className={`ml-auto ${deleteArmed ? 'border-destructive/60 text-destructive' : 'text-destructive/80 hover:border-destructive/50'}`}
        disabled={deleteDisabled}
        onClick={onDelete}
        title="Deleting is a separate explicit action — an empty field never removes anything."
      >
        Delete…
      </Button>
    </div>
  );
}
