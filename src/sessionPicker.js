/** Keyboard state for conversation groups; Enter always selects the parent. */
export function createSessionPicker(groups = [], { currentID = null, allProjects = false } = {}) {
  return { open: true, groups, currentID, allProjects, query: '', selected: 0, scroll: 0, expanded: new Set(), error: '' };
}

export function sessionPickerRows(picker) {
  const query = picker.query.trim().toLocaleLowerCase();
  const rows = [];
  for (const [index, group] of picker.groups.entries()) {
    const searchable = [group.title, group.directory, group.id, ...group.members.flatMap((m) => [m.title, m.role, m.id])].join(' ').toLocaleLowerCase();
    if (query && !searchable.includes(query)) continue;
    rows.push({ group, member: null, number: index + 1 });
    if (picker.expanded.has(group.id) || query) {
      for (const member of group.members) if (member.id !== group.id) rows.push({ group, member, number: index + 1 });
    }
  }
  return rows;
}

export function sessionPickerKey(picker, text, pageSize = 6) {
  const rows = sessionPickerRows(picker), selected = rows[picker.selected];
  const clamp = () => { picker.selected = Math.max(0, Math.min(picker.selected, sessionPickerRows(picker).length - 1)); };
  if (text === '\u0003') return { action: 'quit' };
  if (text === '\x1b') return { action: 'close' };
  if (text === '\t') return { action: 'scope', allProjects: !picker.allProjects };
  if (text === '\r' || text === '\n') return selected ? { action: 'resume', group: selected.group } : { action: 'none' };
  if (text === '\x1b[A') picker.selected--;
  else if (text === '\x1b[B') picker.selected++;
  else if (text === '\x1b[5~') picker.selected -= pageSize;
  else if (text === '\x1b[6~') picker.selected += pageSize;
  else if (text === '\x1b[C') {
    if (selected) { if (picker.expanded.has(selected.group.id)) picker.expanded.delete(selected.group.id); else picker.expanded.add(selected.group.id); }
  } else if (text === '\x1b[D') {
    if (selected) {
      picker.expanded.delete(selected.group.id);
      picker.selected = sessionPickerRows(picker).findIndex((row) => row.group.id === selected.group.id);
    }
  } else if (text === '\x7f' || text === '\b') {
    picker.query = Array.from(picker.query).slice(0, -1).join(''); picker.selected = 0; picker.scroll = 0;
  } else if (!text.includes('\x1b') && !/[\u0000-\u001f\u007f]/.test(text)) {
    picker.query += text; picker.selected = 0; picker.scroll = 0;
  }
  picker.error = ''; clamp();
  return { action: 'changed' };
}
