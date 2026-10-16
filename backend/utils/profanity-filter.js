import { ProfanityEngine } from '@coffeeandfun/google-profanity-words';
import fs from 'fs';
import path from 'path';

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Filter {
    constructor(language = 'en') {
        this.profanityEngine = new ProfanityEngine({ language });
        try {
            const filePath = path.resolve(process.cwd(), 'utils', '_leetspeakMap.json');
            this.leetspeakMap = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const substitutions = Object.keys(this.leetspeakMap)
                .sort((left, right) => right.length - left.length)
                .map(escapeRegExp);
            this.leetspeakPattern = new RegExp(substitutions.join('|'), 'gi');
        } catch (error) {
            throw new Error('Could not load the leetspeak map.', { cause: error });
        }
    }

    normalizeLeetspeak(text) {
        return String(text).replace(this.leetspeakPattern, match =>
            this.leetspeakMap[match] || this.leetspeakMap[match.toLowerCase()] || match,
        );
    }

    async checkContent(content) {
        try {
            const normalizedContent = this.normalizeLeetspeak(content);
            const hasCurseWords = await this.profanityEngine.hasCurseWords(normalizedContent);
            const badWordsList = hasCurseWords
                ? [...new Set((await this.profanityEngine.all())
                    .filter(word => typeof word === 'string' && word.trim())
                    .filter(word => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(normalizedContent)))]
                : [];
            const censoredContent = badWordsList.reduce(
                (censored, word) =>
                    censored.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi'), '*'.repeat(word.length)),
                normalizedContent,
            );

            return {
                isBad: hasCurseWords,
                badWordsTotal: badWordsList.length,
                badWordsList,
                censoredContent,
            };
        } catch (error) {
            throw new Error('Could not process content with the profanity filter.', { cause: error });
        }
    }
}
