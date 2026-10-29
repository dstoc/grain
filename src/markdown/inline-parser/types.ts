export interface SourceSpan {
  startIndex: number;
  endIndex: number;
}

export interface InlineTokenBase extends SourceSpan {
  text: string;
}

export interface TextToken extends InlineTokenBase {
  type: 'text';
}

export type SyntaxTokenKind =
  | 'bracket_open'
  | 'bracket_close'
  | 'paren_open'
  | 'paren_close'
  | 'image_marker'
  | 'delimiter'
  | 'code_span_delimiter';

export interface SyntaxToken extends InlineTokenBase {
  type: 'syntax';
  kind: SyntaxTokenKind;
  marker: string;
  length: number;
}

export interface TagToken extends InlineTokenBase {
  type: 'tag';
  tagName: string;
}

export interface UriAutolinkToken extends InlineTokenBase {
  type: 'uri_autolink';
  url: string;
}

export interface ResolvedCodeSpan extends SourceSpan {
  type: 'code_span';
  text: string;
  innerText: string;
  innerStartIndex: number;
  innerEndIndex: number;
}

export interface ResolvedDelimitedBase extends SourceSpan {
  text: string;
  children: ResolvedInline[];
}

export interface ResolvedEmphasis extends ResolvedDelimitedBase {
  type: 'emphasis';
}

export interface ResolvedStrongEmphasis extends ResolvedDelimitedBase {
  type: 'strong_emphasis';
}

export interface ResolvedStrikethrough extends ResolvedDelimitedBase {
  type: 'strikethrough';
}

export interface ResolvedLinkBase extends SourceSpan {
  text: string;
  label: ResolvedInline[];
}

export interface ResolvedInlineLink extends ResolvedLinkBase {
  type: 'inline_link';
  destination: string;
  destinationStartIndex: number;
  destinationEndIndex: number;
  title?: string;
  titleStartIndex?: number;
  titleEndIndex?: number;
}

export interface ResolvedShortcutLink extends ResolvedLinkBase {
  type: 'shortcut_link';
}

export interface ResolvedImage extends ResolvedLinkBase {
  type: 'image';
  destination: string;
  destinationStartIndex: number;
  destinationEndIndex: number;
  title?: string;
  titleStartIndex?: number;
  titleEndIndex?: number;
}

export type InlineToken = TextToken | SyntaxToken | TagToken | UriAutolinkToken;

export type ResolvedInline =
  | InlineToken
  | ResolvedCodeSpan
  | ResolvedEmphasis
  | ResolvedImage
  | ResolvedInlineLink
  | ResolvedShortcutLink
  | ResolvedStrikethrough
  | ResolvedStrongEmphasis;
