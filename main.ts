import { App, Notice, Plugin, PluginSettingTab, Setting, normalizePath } from 'obsidian';
import Trakt from 'trakt.tv'

interface ShowIds {
	trakt: number
	slug: string
	tvdb: number
	imdb: string
	tmdb: number
	tvrage: unknown
}

interface TraktWatchedShow {
	/** Total episodes of the show played, can be repeated */
	plays: number
	/** Date-String */
	last_watched_at: string
	/** Date-String */
	last_updated_at: string
	show: {
		title: string
		/** Year show premiered */
		year: number
		ids: ShowIds
	}
	seasons: {
		number: number
		episodes: {
			number: number
			plays: number
			/** Date-string */
			last_watched_at: string
		}[]
	}[]
}

interface TraktCheckedInEpisode {
	/** Date-string */
	rated_at: string
	rating: number
	type: 'episode' | 'show' | 'season' | string
	episode ?: {
		season: number
		number: number
		title: string
		ids: ShowIds
	}
	show ?: {
		title: string
		year: number
		ids: ShowIds
	}
	season ?: {
		number: number
		ids: ShowIds	
	}
}

interface TraktSeasonsSummary {

	episodes: {
		season: number
		number: number
		title: string
		/** Date-string */
		last_watched_at: string
	}[]
	ids: ShowIds
	number: number

}


interface TraktSettings {
	apiKey: string;
	secretKey: string;
	// Refresh Token
	refresh?: string;
}
/**
 * Sanitizes a file name by replacing forbidden characters with underscores.
 * Forbidden characters: * " \ / < > : | ?
 */
export function sanitizeFileName(fileName: string): string {
	// Regex matches any of the forbidden characters
	return fileName.replace(/[\*"\\/<>:|?]/g, ' ');
}

const DEFAULT_SETTINGS: TraktSettings = {
	apiKey: "null",
	secretKey: "null",
	refresh: undefined,
}

function dateToJournal(date: Date) {
	return `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}

export default class TraktPlugin extends Plugin {
	settings: TraktSettings;
	trakt: any;
	foldername: string;
	filetext: string;

	async onload() {
		await this.loadSettings();
		this.trakt = new Trakt({
			client_id: this.settings.apiKey,
			client_secret: this.settings.secretKey,
			redirect_uri: 'obsidian://trakt',
			debug: true,
		})

		this.addCommand({
			id: 'sync',
			name: 'Sync watched history',
			callback: async () => {
				if (!this.settings.apiKey || !this.settings.secretKey) {
					return new Notice('Missing Trakt application keys')
				}
				this.trakt = new Trakt({
					client_id: this.settings.apiKey,
					client_secret: this.settings.secretKey,
					redirect_uri: 'obsidian://trakt',
					debug: true,
				})
				if (!this.settings.refresh) {
					new Notice('Cannot get authorization')
				}
				const newToken = await this.trakt.import_token(JSON.parse(this.settings.refresh!))
				this.settings.refresh = JSON.stringify(newToken)
				this.saveSettings(this.settings)
				try {
					await this.trakt.refresh_token()
				} catch (e) {
					new Notice('Authentication error, reauthorization required')
				}
				// Get ratings
				const allCheckinsHistory: TraktCheckedInEpisode[] = await this.trakt.sync.ratings.get({ type: 'all' })

				const foldername = normalizePath('/Trakt')
				if (!this.app.vault.getAbstractFileByPath(foldername)) {
					await this.app.vault.createFolder(foldername)
				}
				const showfoldername = normalizePath('/Trakt/Shows')
				if (!this.app.vault.getAbstractFileByPath(showfoldername)) {
					await this.app.vault.createFolder(showfoldername)
				}
				// Also include "Finished Watching" where appropriate
				const allWatchedHistory: TraktWatchedShow[] = await this.trakt.sync.watched({ type: 'shows' })
				// console.log(allWatchedHistory)
				for (const show of allWatchedHistory) {
					const seasonsummary: TraktSeasonsSummary[] = await this.trakt.seasons.summary({id: show.show.ids.slug, extended:'episodes'})
					const filename = normalizePath(`/Trakt/Shows/${sanitizeFileName(show.show.title)} (${show.show.ids.trakt}).md`)

					// Find show rating from allCheckinsHistory
					const showRatings = allCheckinsHistory.filter(
						ep => ep.show && ep.show.ids.trakt === show.show.ids.trakt && !ep.episode
				 )
					const showRating = showRatings.length > 0 ? showRatings[showRatings.length - 1].rating : ''

					// Find season ratings
					const seasonRatings: Record<number, number | undefined> = {};
					for (const seasonSummary of seasonsummary) {
						const seasonRatingObj = allCheckinsHistory.find(
							ep =>
								ep.show &&
								ep.show.ids.trakt === show.show.ids.trakt &&
								ep.type === 'season' &&
								ep.season &&
								ep.season.number === seasonSummary.number
						);
						if (seasonRatingObj && typeof seasonRatingObj.rating === 'number') {
							seasonRatings[seasonSummary.number] = seasonRatingObj.rating;
						}
					}

					const yamlBlock = `---\naliases:\n  - ${sanitizeFileName(show.show.title)}\nurl: https://trakt.tv/shows/${show.show.ids.slug}\ntrakt: ${show.show.ids.trakt}\ntvdb: ${show.show.ids.tvdb}\nimdb: ${show.show.ids.imdb}\ntmdb: ${show.show.ids.tmdb}\ntvrage: ${show.show.ids.tvrage}\nyear: ${show.show.year}\nseasons: ${seasonsummary.length}\nepisodes: ${seasonsummary.reduce((sum, season) => sum + season.episodes.length, 0)}\nrating: ${showRating}\n---\n\n`
					let filetext = yamlBlock
					filetext += `# ${show.show.title}\n\n`
					filetext += `## Watch Progress\n`
					for (const seasonSummary of seasonsummary) {
						const showSeason = show.seasons.find(s => s.number === seasonSummary.number);
						const watchedCount = showSeason
							? showSeason.episodes.reduce((sum, ep) => sum + (ep.plays > 0 ? 1 : 0), 0)
							: 0;
						const totalEpisodes = seasonSummary.episodes.length;
						const seasonRating = seasonRatings[seasonSummary.number]
						filetext += `- Season ${seasonSummary.number}: Watched ${watchedCount} / ${totalEpisodes} episodes${seasonRating !== undefined ? ` | ${seasonRating}/10` : ''}\n`;
					}
					filetext += `\n`
					filetext += `\n## General Notes\n\n`
					filetext += `\n## Episodes\n`
					for (const season of seasonsummary) {
						for (const episode of season.episodes) {
							const showSeason = show.seasons.find(s => s.number === season.number);
							const showEpisode = showSeason?.episodes.find(e => e.number === episode.number);
							const formattedLastWatched = showEpisode?.last_watched_at
								? ` | Watched: [[${dateToJournal(new Date(showEpisode.last_watched_at))}]]`
								: '';
							// Find rating for this episode in allCheckinsHistory
							const episodeRatingObj = allCheckinsHistory.find(
								ep =>
									ep.episode &&
									ep.show &&
									ep.show.ids.trakt === show.show.ids.trakt &&
									ep.episode.season === season.number &&
									ep.episode.number === episode.number
							);
							const ratingStr = episodeRatingObj ? ` | ${episodeRatingObj.rating}/10` : '';
							filetext += `#### S${season.number} Ep${episode.number} | ${episode.title}${formattedLastWatched}${ratingStr}\n`;
						}
					}
					if (this.app.vault.getAbstractFileByPath(filename)) {
						const file = this.app.vault.getFileByPath(filename)
						if (file) {
							const content = await this.app.vault.read(file)
							// Split YAML frontmatter and rest
							const yamlMatch = content.match(/^---[\s\S]*?---\n?/);
							const yamlEnd = yamlMatch ? yamlMatch[0].length : 0;
							const yamlContent = yamlMatch ? yamlMatch[0] : '';
							const restContent = content.slice(yamlEnd);

							// Only update specific YAML fields, preserve others
							const updatedYamlFields = {
								trakt: show.show.ids.trakt,
								tvdb: show.show.ids.tvdb,
								imdb: show.show.ids.imdb,
								tmdb: show.show.ids.tmdb,
								tvrage: show.show.ids.tvrage,
								year: show.show.year,
								seasons: seasonsummary.length,
								episodes: seasonsummary.reduce((sum, season) => sum + season.episodes.length, 0),
								rating: showRating
							};

							// Replace only the specified fields in the YAML block
							let updatedYaml = yamlContent;
							for (const [key, value] of Object.entries(updatedYamlFields)) {
								const regex = new RegExp(`^(${key}:)[^\n]*`, 'm');
								if (regex.test(updatedYaml)) {
									updatedYaml = updatedYaml.replace(regex, `$1 ${value}`);
								} else {
									// If field doesn't exist, add it before the closing ---
									updatedYaml = updatedYaml.replace(/---\s*$/, `${key}: ${value}\n---`);
								}
							}

							let updatedContent = updatedYaml.trimEnd() + '\n' +
								restContent.replace(/^# .*\n/, `# ${show.show.title}\n`).replace(/^\n+/, '');

							// Update or append Watch Progress (no extra newline)
							const updatedWatchProgress = filetext.match(/## Watch Progress[\s\S]*?(?=\n## General Notes|\n## Notes|\n## Episodes|\n$)/)?.[0] ?? '';
							let finalWatchProgress = updatedWatchProgress;

							// If there is an existing Watch Progress, preserve any extra notes after each season line,
							// but update the rating value for each season.
							const existingWatchProgress = restContent.match(/## Watch Progress[\s\S]*?(?=\n## General Notes|\n## Notes|\n## Episodes|\n$)/)?.[0] ?? '';
							if (existingWatchProgress) {
								const updatedLines = updatedWatchProgress.split('\n');
								const existingLines = existingWatchProgress.split('\n');
								const mergedLines: string[] = [];

								   // Merge each season line, always updating watched count and rating, but preserve extra notes/comments
								   for (const updatedLine of updatedLines) {
									   const seasonMatch = updatedLine.match(/- Season (\d+):/);
									   if (seasonMatch) {
										   const seasonNum = seasonMatch[1];
										   const existingLine = existingLines.find(l => l.startsWith(`- Season ${seasonNum}:`));
										   if (existingLine) {
											   // Extract any extra notes/comments after the watched/rating part
											   // Match: - Season X: Watched N / M episodes [| R/10] [extra]
											   const extraMatch = existingLine.match(/^(.*?episodes(?:\s*\|\s*\d+\/10)?)(.*)$/);
											   let extra = '';
											   if (extraMatch) {
												   extra = extraMatch[2];
											   }
											   // Use the updated watched count and rating, append any extra
											   let mergedLine = updatedLine + extra;
											   mergedLines.push(mergedLine);
										   } else {
											   mergedLines.push(updatedLine);
										   }
									   } else {
										   mergedLines.push(updatedLine);
									   }
								   }
								   finalWatchProgress = mergedLines.join('\n');
							}

							if (/## Watch Progress[\s\S]*?(?=\n## General Notes|\n## Notes|\n## Episodes|\n$)/.test(restContent)) {
								updatedContent = updatedContent.replace(/## Watch Progress[\s\S]*?(?=\n## General Notes|\n## Notes|\n## Episodes|\n$)/, finalWatchProgress.trimEnd());
							} else {
								updatedContent += finalWatchProgress.trimEnd();
							}

							// Always preserve General Notes section
							const existingGeneralNotes = restContent.match(/## General Notes[\s\S]*?(?=\n## Notes|\n## Episodes|\n$)/)?.[0] ?? '';
							if (existingGeneralNotes) {
								if (/## General Notes[\s\S]*?(?=\n## Notes|\n## Episodes|\n$)/.test(updatedContent)) {
									updatedContent = updatedContent.replace(/## General Notes[\s\S]*?(?=\n## Notes|\n## Episodes|\n$)/, existingGeneralNotes);
								} else {
									updatedContent += existingGeneralNotes;
								}
							}

							// Always preserve Notes section
							const existingNotes = restContent.match(/## Notes[\s\S]*?(?=\n## General Notes|\n## Episodes|\n$)/)?.[0] ?? '';
							if (existingNotes) {
								if (/## Notes[\s\S]*?(?=\n## General Notes|\n## Episodes|\n$)/.test(updatedContent)) {
									updatedContent = updatedContent.replace(/## Notes[\s\S]*?(?=\n## General Notes|\n## Episodes|\n$)/, existingNotes);
								} else {
									updatedContent += existingNotes;
								}
							}

							// For Episodes, merge updated episode headers with any text between them (no extra newlines)
							const updatedEpisodes = filetext.match(/## Episodes[\s\S]*$/m)?.[0] ?? '';
							const existingEpisodesSection = restContent.match(/## Episodes[\s\S]*$/m)?.[0] ?? '';
							if (existingEpisodesSection) {
								const updatedEpisodeHeaders = Array.from(updatedEpisodes.matchAll(/^#### S(\d+) Ep(\d+) \| .*/gm));
								const existingEpisodeBlocks = existingEpisodesSection.split(/^#### /gm).filter(Boolean);

								let mergedEpisodes = '## Episodes\n';
								   for (const headerMatch of updatedEpisodeHeaders) {
									   let header = headerMatch[0];
									   const seasonNum = headerMatch[1];
									   const episodeNum = headerMatch[2];
									   const block = existingEpisodeBlocks.find(b => b.startsWith(`S${seasonNum} Ep${episodeNum}`));
									   if (block) {
										   // Parse updated header for prefix, title, watched date, and rating
										   const headerParts = header.match(/^#### (S\d+ Ep\d+) \| ([^|\n]+)(.*)$/);
										   let prefix = '', episodeTitle = '', rest = '';
										   if (headerParts) {
											   prefix = headerParts[1];
											   episodeTitle = headerParts[2].trim();
											   rest = headerParts[3] || '';
										   }
										   const updatedWatchedDate = rest.match(/\| Watched: [^|\n]+/)?.[0] || '';
										   const updatedRating = rest.match(/\| \d+\/10/)?.[0] || '';
										   let mergedBlock = block.trim();
										   // Remove any existing rating and watched date from the block
										   mergedBlock = mergedBlock.replace(/\| \d+\/10/g, '');
										   mergedBlock = mergedBlock.replace(/\| Watched: \[\[[^\]]+\]\]/g, '');
										   // Rebuild header: always prefix, title, then watched date, then rating
										   let rebuiltHeader = `${prefix} | ${episodeTitle}`;
										   if (updatedWatchedDate) rebuiltHeader += ` ${updatedWatchedDate}`;
										   if (updatedRating) rebuiltHeader += ` ${updatedRating}`;
										   // Add any extra notes/comments from the original block (after the first line)
										   const extra = mergedBlock.split('\n').slice(1).join('\n');
										   mergedEpisodes += `#### ${rebuiltHeader}${extra ? '\n' + extra : ''}\n`;
									   } else {
										   // Robustly split at the first '|' after episode number, trim and rebuild
										   let pipeIdx = header.indexOf('|');
										   let normalizedHeader = '';
										   if (pipeIdx !== -1) {
											   let beforePipe = header.slice(0, pipeIdx).trimEnd();
											   let afterPipe = header.slice(pipeIdx);
											   normalizedHeader = `${beforePipe} ${afterPipe}`;
										   } else {
											   normalizedHeader = header;
										   }
										   mergedEpisodes += normalizedHeader + '\n';
									   }
								   }
								updatedContent = updatedContent.replace(/## Episodes[\s\S]*$/m, mergedEpisodes.trimEnd());
							} else {
								// Ensure each episode starts on a new line, but no extra blank lines
								const formattedEpisodes = updatedEpisodes
									.replace(/(#### [^\n]+)\n?/g, '$1\n')
									.trimEnd();
								updatedContent = updatedContent.replace(/## Episodes[\s\S]*$/m, formattedEpisodes);
							}

							// Remove extra blank lines after YAML frontmatter
							updatedContent = updatedContent.replace(/(---\n+)(\n+)/, '$1');

							await this.app.vault.modify(file, updatedContent)
						}
						continue; // Don't create new file
					}
					this.filetext = filetext;

					if (!this.app.vault.getAbstractFileByPath(filename)) {
						await this.app.vault.create(filename, this.filetext)
					}
				}
			},
		})

		this.addSettingTab(new TraktSettingTab(this.app, this));

		this.registerObsidianProtocolHandler('trakt', async (data) => {
			const {code, state} = data
			await this.trakt.exchange_code(code, state)
			this.settings.refresh = JSON.stringify(this.trakt.export_token())
			await this.saveSettings(this.settings)
			new Notice('You are now connected to Trakt')
		})
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(settings: TraktSettings) {
		await this.saveData(settings);
	}
}

class TraktSettingTab extends PluginSettingTab {
	plugin: TraktPlugin;
	settings: any
	displayInterval?: unknown

	constructor(app: App, plugin: TraktPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	async display(): Promise<void> {
		const {containerEl} = this;
		this.settings = await this.plugin.loadData() ?? DEFAULT_SETTINGS

		containerEl.empty();

		new Setting(containerEl)
			.setName('Trakt API key')
			.setDesc('Client API key')
			.addText((component) => {
				component.setValue(this.settings.apiKey ?? '')
				component.onChange(async (value) => {
					this.settings.apiKey = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		new Setting(containerEl)
			.setName('Trakt secret key')
			.setDesc('Secret key')
			.addText((component) => {
				component.setValue(this.settings.secretKey ?? '')
				component.onChange(async (value) => {
					this.settings.secretKey = value
					await this.plugin.saveSettings(this.settings)
				})
			})

		if (this.settings.refresh) {
			clearInterval(this.displayInterval as number)
			new Setting(containerEl)
				.setName('Connected to Trakt')
				.addButton((component) => {
					component.setButtonText('Remove Authorization')
					component.onClick(async () => {
						delete this.settings.refresh
						await this.plugin.saveSettings(this.settings)
						new Notice('Logged out of Trakt account')
						this.display() // Reload
					})
				})
		} else {
			new Setting(containerEl)
				.setName('Connect to Trakt account')
				.addButton((component) => {
					component.setButtonText('Connect')
					component.onClick(() => {
						const traktAuthUrl = this.plugin.trakt.get_url()
						window.location.href = traktAuthUrl
						this.displayInterval = setInterval(() => {
							this.display()
						}, 250)
					})
				})
		}

	}
}