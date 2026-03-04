/**
 * Standardized Error Handler
 * 
 * Provides consistent error handling and user-friendly error messages.
 * Separates operational errors (expected) from programming errors (unexpected).
 */

import { Logger, getLogger } from './logger.js';

/**
 * Centralized error codes for programmatic handling
 */
export const ErrorCodes = {
    FILE_NOT_FOUND: 'FILE_NOT_FOUND',
    FILE_READ_ERROR: 'FILE_READ_ERROR',
    PLAYBOOK_NOT_FOUND: 'PLAYBOOK_NOT_FOUND',
    DESCRIPTION_PARSE_ERROR: 'DESCRIPTION_PARSE_ERROR',
    PLAYBOOK_PARSE_ERROR: 'PLAYBOOK_PARSE_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];

export class OmlError extends Error {
    /** Original error that caused this error (for stack trace chaining) */
    public readonly originalCause?: Error;

    constructor(
        override message: string,
        public code: ErrorCode,
        public details?: Record<string, any>,
        cause?: Error,
    ) {
        super(message);
        this.name = 'OmlError';
        this.originalCause = cause;
    }

    toJSON() {
        return {
            error: this.message,
            code: this.code,
            details: this.details,
            cause: this.originalCause?.message,
        };
    }
}

export class FileNotFoundError extends OmlError {
    constructor(filePath: string) {
        super(`File not found: ${filePath}`, ErrorCodes.FILE_NOT_FOUND, { filePath });
    }
}

export class FileReadError extends OmlError {
    constructor(filePath: string, originalError: Error) {
        super(
            `Failed to read file: ${filePath}`,
            ErrorCodes.FILE_READ_ERROR,
            { filePath },
            originalError,
        );
    }
}

export class PlaybookNotFoundError extends OmlError {
    constructor(searchLocation?: string) {
        super(
            `Methodology SHACL shapes not found${searchLocation ? ` in ${searchLocation}` : ''}. Provide shapesPath or add a matching shape file under a shapes/ directory.`,
            ErrorCodes.PLAYBOOK_NOT_FOUND,
            { searchLocation },
        );
    }
}

export class DescriptionParseError extends OmlError {
    constructor(descriptionPath: string, originalError: Error) {
        super(
            `Failed to parse OML description: ${descriptionPath}`,
            ErrorCodes.DESCRIPTION_PARSE_ERROR,
            { descriptionPath },
            originalError,
        );
    }
}

export class PlaybookParseError extends OmlError {
    constructor(playbookPath: string, originalError: Error) {
        super(
            `Failed to parse methodology shapes/config: ${playbookPath}`,
            ErrorCodes.PLAYBOOK_PARSE_ERROR,
            { playbookPath },
            originalError,
        );
    }
}

export class ValidationError extends OmlError {
    constructor(message: string, context?: Record<string, any>) {
        super(message, ErrorCodes.VALIDATION_ERROR, context);
    }
}

/**
 * Handle errors and return a user-friendly response
 */
export function handleError(
    error: unknown,
    context?: string,
    logger?: Logger,
): { content: { type: 'text'; text: string }[]; isError: boolean } {
    const log = logger || getLogger('error-handler');

    if (error instanceof OmlError) {
        log.warn(`Operational error: ${error.code}`, { context, ...error.details });
        return {
            content: [{ type: 'text', text: `**Error:** ${error.message}` }],
            isError: true,
        };
    }

    if (error instanceof Error) {
        log.error(`Unexpected error: ${error.message}`, error, { context });
        return {
            content: [
                {
                    type: 'text',
                    text: `**Unexpected Error:** ${error.message}\n\nPlease check the server logs for details.`,
                },
            ],
            isError: true,
        };
    }

    log.error(`Unknown error type`, error, { context });
    return {
        content: [
            {
                type: 'text',
                text: `**Unknown Error:** ${String(error)}\n\nPlease check the server logs.`,
            },
        ],
        isError: true,
    };
}
