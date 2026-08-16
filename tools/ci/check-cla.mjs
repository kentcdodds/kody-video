import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const individualClaSigningPhrase =
	'I have read the CLA and I hereby sign the CLA'

const githubBotLoginPattern = /\[bot\]$/i

function normalize(value) {
	return value.trim().toLowerCase()
}

function identityLabel(identity) {
	if (identity.githubLogin) {
		return `@${identity.githubLogin}`
	}
	if (identity.email) {
		return identity.email
	}
	if (identity.name) {
		return identity.name
	}
	return 'unknown identity'
}

export function parseClaSignersFile(raw) {
	const parsed = JSON.parse(raw)
	if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) {
		throw new Error('CLA signers file must be version 1 JSON')
	}
	if (
		typeof parsed.document !== 'string' ||
		typeof parsed.allowlist !== 'object' ||
		parsed.allowlist === null ||
		!Array.isArray(parsed.allowlist.github) ||
		!Array.isArray(parsed.allowlist.email) ||
		!Array.isArray(parsed.signers)
	) {
		throw new Error('CLA signers file is missing allowlist or signers')
	}
	return parsed
}

export function serializeClaSignersFile(file) {
	const compactStringArray = (values) =>
		`[${values.map((value) => JSON.stringify(value)).join(', ')}]`
	const placeholderGithub = '__CLA_ALLOWLIST_GITHUB__'
	const placeholderEmail = '__CLA_ALLOWLIST_EMAIL__'
	const indented = JSON.stringify(
		{
			...file,
			allowlist: { github: placeholderGithub, email: placeholderEmail },
		},
		null,
		'\t',
	)
		.replace(
			JSON.stringify(placeholderGithub),
			compactStringArray(file.allowlist.github),
		)
		.replace(
			JSON.stringify(placeholderEmail),
			compactStringArray(file.allowlist.email),
		)
	return `${indented}\n`
}

export function isIndividualClaSigningComment(body) {
	return body.trim() === individualClaSigningPhrase
}

export function applyIndividualClaSigningComment(input) {
	if (!isIndividualClaSigningComment(input.comment)) {
		return {
			file: input.file,
			status: 'ignored',
			reason: 'not_signing_comment',
		}
	}

	const login = input.github.trim()
	if (!login) {
		return { file: input.file, status: 'ignored', reason: 'missing_login' }
	}

	if (
		input.file.signers.some(
			(signer) => normalize(signer.github) === normalize(login),
		)
	) {
		return { file: input.file, status: 'already_signed', github: login }
	}

	return {
		file: {
			...input.file,
			signers: [
				...input.file.signers,
				{
					github: login,
					signedAt: input.signedAt,
					cla: 'individual',
				},
			],
		},
		status: 'recorded',
		github: login,
	}
}

export function isAllowlistedIdentity(identity, signersFile) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (
		login &&
		(githubBotLoginPattern.test(login) || login.startsWith('app/'))
	) {
		return true
	}
	if (
		login &&
		signersFile.allowlist.github.some((entry) => normalize(entry) === login)
	) {
		return true
	}
	const email = identity.email ? normalize(identity.email) : null
	return Boolean(
		email &&
		signersFile.allowlist.email.some((entry) => normalize(entry) === email),
	)
}

export function hasSignedCla(identity, signersFile) {
	const login = identity.githubLogin ? normalize(identity.githubLogin) : null
	if (!login) {
		return false
	}
	return signersFile.signers.some(
		(signer) => normalize(signer.github) === login,
	)
}

export function checkClaIdentities(identities, signersFile) {
	const missing = []
	const seen = new Set()
	for (const identity of identities) {
		const key = [identity.githubLogin, identity.email, identity.name]
			.map((part) => (part ? normalize(part) : ''))
			.join('|')
		if (seen.has(key)) {
			continue
		}
		seen.add(key)
		if (isAllowlistedIdentity(identity, signersFile)) {
			continue
		}
		if (hasSignedCla(identity, signersFile)) {
			continue
		}
		const reason = identity.githubLogin
			? `${identityLabel(identity)} has not signed the CLA`
			: `${identityLabel(identity)} has no GitHub login and is not a Licensor email`
		missing.push({ identity, reason })
	}
	return missing.length === 0 ? { ok: true } : { ok: false, missing }
}

export function formatClaFailure(result) {
	return [
		'Unsigned contributions cannot merge.',
		'Read docs/legal/individual-cla.md (or the Entity CLA if an organization owns the work).',
		'Comment on the pull request: I have read the CLA and I hereby sign the CLA',
		'The CLA workflow records that GitHub username on main. See the inbound contributions doc.',
		'',
		'Missing signatures:',
		...result.missing.map((entry) => `- ${entry.reason}`),
	].join('\n')
}

function fixtureSignersFile() {
	return {
		version: 1,
		document: 'docs/legal/individual-cla.md',
		allowlist: {
			github: ['kentcdodds', 'kody-bot', 'cursoragent'],
			email: ['me@kentcdodds.com', 'me+github@kentcdodds.com'],
		},
		signers: [
			{ github: 'ExampleSigner', signedAt: '2026-08-16', cla: 'individual' },
		],
	}
}

function runSelfTest() {
	const file = fixtureSignersFile()
	const passing = checkClaIdentities(
		[
			{ githubLogin: 'kentcdodds', name: 'Kent', email: null },
			{ githubLogin: 'kody-bot', name: 'Kody', email: null },
			{
				githubLogin: 'cursoragent',
				name: 'Cursor Agent',
				email: 'cursoragent@cursor.com',
			},
			{ githubLogin: 'cursor[bot]', name: 'cursor[bot]', email: null },
			{ githubLogin: 'app/imgbot', name: 'ImgBot', email: null },
			{
				githubLogin: null,
				name: 'Kent C. Dodds',
				email: 'me+github@kentcdodds.com',
			},
			{
				githubLogin: 'examplesigner',
				name: 'Example Signer',
				email: 'signer@example.com',
			},
		],
		file,
	)
	if (!passing.ok) {
		throw new Error('expected allowlisted and signed identities to pass')
	}

	const failing = checkClaIdentities(
		[
			{ githubLogin: 'kentcdodds', name: 'Kent', email: null },
			{
				githubLogin: 'someone-else',
				name: 'Someone',
				email: 'someone@example.com',
			},
			{
				githubLogin: null,
				name: 'Someone',
				email: 'someone@example.com',
			},
		],
		file,
	)
	if (failing.ok) {
		throw new Error('expected unsigned identities to fail')
	}
	const reasons = failing.missing.map((entry) => entry.reason)
	if (
		reasons[0] !== '@someone-else has not signed the CLA' ||
		reasons[1] !==
			'someone@example.com has no GitHub login and is not a Licensor email'
	) {
		throw new Error(`unexpected failure reasons: ${reasons.join('; ')}`)
	}

	const empty = { ...file, signers: [] }
	const recorded = applyIndividualClaSigningComment({
		file: empty,
		github: 'ExampleSigner',
		signedAt: '2026-08-16',
		comment: individualClaSigningPhrase,
	})
	if (recorded.status !== 'recorded') {
		throw new Error('expected the signing comment to record a signer')
	}
	const again = applyIndividualClaSigningComment({
		file: recorded.file,
		github: 'examplesigner',
		signedAt: '2026-08-17',
		comment: individualClaSigningPhrase,
	})
	if (again.status !== 'already_signed') {
		throw new Error('expected a second signing comment to be idempotent')
	}
	console.log('CLA self-test passed')
}

function readFlag(args, flag) {
	const index = args.indexOf(flag)
	if (index === -1) {
		return null
	}
	const value = args[index + 1]
	if (!value || value.startsWith('--')) {
		return null
	}
	return value
}

async function runRecordCli(args) {
	const signersPath = readFlag(args, '--signers')
	const github = readFlag(args, '--record-signer')
	const signedAt = readFlag(args, '--signed-at')
	const commentPath = readFlag(args, '--comment-file')
	if (!signersPath || !github || !signedAt || !commentPath) {
		throw new Error(
			'Usage: node tools/ci/check-cla.mjs --signers <file> --record-signer <login> --signed-at <YYYY-MM-DD> --comment-file <file>',
		)
	}

	const current = parseClaSignersFile(await readFile(signersPath, 'utf8'))
	const recorded = applyIndividualClaSigningComment({
		file: current,
		github,
		signedAt,
		comment: await readFile(commentPath, 'utf8'),
	})

	switch (recorded.status) {
		case 'ignored':
			console.log('skipped=true')
			console.log('added=false')
			break
		case 'already_signed':
			console.log('skipped=false')
			console.log('added=false')
			console.log(`github=${recorded.github}`)
			break
		case 'recorded':
			await writeFile(
				signersPath,
				serializeClaSignersFile(recorded.file),
				'utf8',
			)
			console.log('skipped=false')
			console.log('added=true')
			console.log(`github=${recorded.github}`)
			break
		default:
			throw new Error(`Unhandled CLA record status: ${recorded.status}`)
	}
}

async function runCheckCli(args) {
	const signersPath = readFlag(args, '--signers')
	const identitiesPath = readFlag(args, '--identities-json')
	if (!signersPath || !identitiesPath) {
		throw new Error(
			'Usage: node tools/ci/check-cla.mjs --signers <file> --identities-json <file>',
		)
	}
	const signersFile = parseClaSignersFile(await readFile(signersPath, 'utf8'))
	const identitiesRaw = JSON.parse(await readFile(identitiesPath, 'utf8'))
	if (!Array.isArray(identitiesRaw)) {
		throw new Error('Identities JSON must be an array')
	}
	const result = checkClaIdentities(identitiesRaw, signersFile)
	if (!result.ok) {
		console.error(formatClaFailure(result))
		process.exitCode = 1
	}
}

async function runCli(args) {
	if (args.includes('--self-test')) {
		runSelfTest()
		return
	}
	if (args.includes('--record-signer')) {
		await runRecordCli(args)
		return
	}
	await runCheckCli(args)
}

const entryPoint = process.argv[1]
if (
	entryPoint &&
	pathToFileURL(path.resolve(entryPoint)).href === import.meta.url
) {
	await runCli(process.argv.slice(2))
}
