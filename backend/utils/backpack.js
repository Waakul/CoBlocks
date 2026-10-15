export const MAX_BACKPACK_ITEMS = 50;
export const MAX_BACKPACK_BLOCKS = 5_000;
export const MAX_BACKPACK_DATA_LENGTH = 1_000_000;
export const MAX_BACKPACK_THUMBNAIL_LENGTH = 150_000;

export function validateBackpackItem(input) {
    const name = (typeof input?.name === 'string' ? input.name.trim() : '').slice(0, 80) || 'Script';
    const blocks = input?.blocks;
    if (!Array.isArray(blocks) || !blocks.length || blocks.length > MAX_BACKPACK_BLOCKS) {
        return { error: 'That backpack item is not valid Scratch VM block data.' };
    }
    if (!blocks.every(block => block && typeof block === 'object' && !Array.isArray(block) &&
        typeof block.id === 'string' && block.id && typeof block.opcode === 'string' && block.opcode)) {
        return { error: 'That backpack item contains invalid Scratch blocks.' };
    }
    let serialized;
    try { serialized = JSON.stringify(blocks); } catch { return { error: 'That backpack item could not be serialized.' }; }
    if (serialized.length > MAX_BACKPACK_DATA_LENGTH) return { error: 'That script is too large for the shared backpack.' };
    const thumbnail = typeof input?.thumbnail === 'string' && input.thumbnail.length <= MAX_BACKPACK_THUMBNAIL_LENGTH &&
        /^data:image\/png;base64,[a-z0-9+/=]+$/i.test(input.thumbnail) ? input.thumbnail : null;
    return { value: { type: 'script', name, blocks: JSON.parse(serialized), thumbnail } };
}

export function normalizeBackpack(project) {
    if (!Array.isArray(project.backpack)) project.backpack = [];
    const validItems = project.backpack.filter(item => item?.type === 'script' && Array.isArray(item.blocks));
    if (validItems.length !== project.backpack.length) project.backpack.splice(0, project.backpack.length, ...validItems);
    return project.backpack;
}

export function canDeleteBackpackItem(project, item, username) {
    const normalized = String(username).toLowerCase();
    return normalized === String(project?.owner).toLowerCase() || normalized === String(item?.createdBy).toLowerCase();
}
