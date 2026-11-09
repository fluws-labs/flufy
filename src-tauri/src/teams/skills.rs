use super::domain::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Definition {
    id: String,
    slug: String,
    name: String,
    version: u32,
    description: String,
    verification_guidelines: Vec<String>,
}

const DOCUMENTS: &[(&str, &str)] = &[
    (
        "aws",
        include_str!("../../../.opencode/skills/aws/SKILL.md"),
    ),
    (
        "backend",
        include_str!("../../../.opencode/skills/backend/SKILL.md"),
    ),
    (
        "code-reviewer",
        include_str!("../../../.opencode/skills/code-reviewer/SKILL.md"),
    ),
    (
        "comportamientos",
        include_str!("../../../.opencode/skills/comportamientos/SKILL.md"),
    ),
    (
        "database",
        include_str!("../../../.opencode/skills/database/SKILL.md"),
    ),
    (
        "devops",
        include_str!("../../../.opencode/skills/devops/SKILL.md"),
    ),
    (
        "docker",
        include_str!("../../../.opencode/skills/docker/SKILL.md"),
    ),
    (
        "frontend",
        include_str!("../../../.opencode/skills/frontend/SKILL.md"),
    ),
    (
        "git-integration",
        include_str!("../../../.opencode/skills/git-integration/SKILL.md"),
    ),
    (
        "graphql",
        include_str!("../../../.opencode/skills/graphql/SKILL.md"),
    ),
    ("qa", include_str!("../../../.opencode/skills/qa/SKILL.md")),
    (
        "security",
        include_str!("../../../.opencode/skills/security/SKILL.md"),
    ),
    (
        "team-lead",
        include_str!("../../../.opencode/skills/team-lead/SKILL.md"),
    ),
    (
        "superpowers-systematic-debugging",
        include_str!("../../../.opencode/skills/superpowers-systematic-debugging/SKILL.md"),
    ),
    (
        "superpowers-verification-before-completion",
        include_str!("../../../.opencode/skills/superpowers-verification-before-completion/SKILL.md"),
    ),
    (
        "superpowers-requesting-code-review",
        include_str!("../../../.opencode/skills/superpowers-requesting-code-review/SKILL.md"),
    ),
    (
        "superpowers-receiving-code-review",
        include_str!("../../../.opencode/skills/superpowers-receiving-code-review/SKILL.md"),
    ),
    (
        "superpowers-test-driven-development",
        include_str!("../../../.opencode/skills/superpowers-test-driven-development/SKILL.md"),
    ),
    (
        "superpowers-writing-plans",
        include_str!("../../../.opencode/skills/superpowers-writing-plans/SKILL.md"),
    ),
    (
        "superpowers-executing-plans",
        include_str!("../../../.opencode/skills/superpowers-executing-plans/SKILL.md"),
    ),
    (
        "superpowers-writing-skills",
        include_str!("../../../.opencode/skills/superpowers-writing-skills/SKILL.md"),
    ),
    (
        "superpowers-brainstorming",
        include_str!("../../../.opencode/skills/superpowers-brainstorming/SKILL.md"),
    ),
];

pub fn catalog() -> Vec<Skill> {
    let mut definitions: Vec<Definition> =
        serde_json::from_str(include_str!("../../../.opencode/skills/catalog.json"))
            .expect("bundled skill catalog");
    // Curated, independent skills only: no upstream bootstrap or default role
    // assignment. Existing selections and chat/run snapshots remain unchanged.
    definitions.extend(serde_json::from_str::<Vec<Definition>>(include_str!(
        "../../../.opencode/skills/superpowers-catalog.json"
    )).expect("curated superpowers catalog"));
    definitions
        .into_iter()
        .map(|d| {
            let document = DOCUMENTS
                .iter()
                .find(|(slug, _)| *slug == d.slug)
                .expect("bundled skill document")
                .1;
            let document = document.replace("\r\n", "\n");
            let instructions = document
                .strip_prefix("---\n")
                .and_then(|s| s.split_once("\n---\n"))
                .expect("skill frontmatter")
                .1
                .trim()
                .to_string();
            Skill {
                id: d.id,
                name: d.name,
                version: d.version,
                description: d.description,
                instructions,
                verification_guidelines: d.verification_guidelines,
            }
        })
        .collect()
}

fn previous_bundled(skill: &Skill) -> bool {
    let fingerprints: std::collections::HashMap<String, String> = serde_json::from_str(include_str!("../../../.opencode/skills/bundled-v2-sha256.json")).expect("bundled v2 fingerprints");
    let digest = serde_json::to_vec(skill).map(|bytes| format!("{:x}", Sha256::digest(bytes))).ok();
    digest.as_ref().is_some_and(|digest| fingerprints.get(&skill.id) == Some(digest))
}

pub fn upgrade(store: &mut Store) {
    let legacy = legacy_catalog();
    for skill in catalog() {
        let existing: Vec<_> = store.skills.iter().filter(|s| s.id == skill.id).collect();
        // A customized version is never replaced or hidden by a bundled update.
        let upgrade_default = existing.iter().max_by_key(|s| s.version).is_some_and(|latest| {
            previous_bundled(latest) || legacy.iter().any(|old| {
                old.id == skill.id
                    && serde_json::to_value(old).ok() == serde_json::to_value(latest).ok()
            })
        });
        if existing.is_empty() || upgrade_default {
            store.skills.push(skill);
        }
    }
    // Templates with no skills get useful defaults. Existing selections and all
    // immutable chat/run snapshots keep their original versions and contents.
    for team in &mut store.teams {
        for member in &mut team.members {
            if member.skill_refs.is_empty() && member.id == team.lead_agent_id {
                member.skill_refs = store
                    .skills
                    .iter()
                    .filter(|s| ["team-lead", "comportamientos"].contains(&s.id.as_str()))
                    .filter(|s| {
                        !store
                            .skills
                            .iter()
                            .any(|v| v.id == s.id && v.version > s.version)
                    })
                    .map(|s| SkillRef {
                        id: s.id.clone(),
                        version: s.version,
                    })
                    .collect();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn catalog_upgrade_keeps_custom_versions_and_chat_snapshots() {
        let mut store = Store {
            fallback_models: vec![],
            schema_version: 2,
            teams: vec![super::super::domain::tests::team()],
            skills: legacy_catalog(),
            chats: vec![],
        };
        let mut custom = store
            .skills
            .iter()
            .find(|s| s.id == "backend")
            .unwrap()
            .clone();
        custom.version = 2;
        custom.instructions = "Custom backend rules".into();
        store.skills.push(custom);
        let snapshot = store.teams[0].clone();
        store.chats.push(Chat {
            continuous_mode: false,
            origin: None,
            messages: vec![],
            id: "chat".into(),
            title: "Original".into(),
            archived: false,
            team: snapshot,
            skills: store.skills.clone(),
            created_at: 0,
            runs: vec![],
            memory: None,
            auto_approve: None,
        });
        let original = serde_json::to_value(&store.chats).unwrap();
        upgrade(&mut store);
        assert_eq!(serde_json::to_value(&store.chats).unwrap(), original);
        assert_eq!(store.skills.iter().filter(|s| s.id == "backend").count(), 2);
        assert_eq!(
            store
                .skills
                .iter()
                .find(|s| s.id == "backend" && s.version == 2)
                .unwrap()
                .instructions,
            "Custom backend rules"
        );
        assert!(store
            .skills
            .iter()
            .any(|s| s.id == "frontend" && s.version == 3));
        assert_eq!(store.teams[0].members[0].skill_refs.len(), 2);
        let count = store.skills.len();
        upgrade(&mut store);
        assert_eq!(store.skills.len(), count);
    }
    #[test]
    fn bundled_skills_have_observable_checks_and_runner_contracts() {
        let skills = catalog();
        assert_eq!(skills.len(), 22);
        for s in skills {
            assert!(s.instructions.contains("Contrato de Flufy"));
            assert!(!s.verification_guidelines.is_empty());
            assert!(s.instructions.len() > 1000 && s.instructions.len() < 32_000);
        }
    }
    #[test]
    fn bundled_v2_upgrade_preserves_custom_instructions() {
        let mut old: Skill = serde_json::from_str(include_str!("../../../tests/fixtures/frontend-v2.json"))
            .expect("exact shipped v2 frontend skill");
        assert_eq!(old.version, 2);
        assert!(previous_bundled(&old), "fingerprint must match the exact shipped v2 skill");
        let mut store = Store { fallback_models: vec![], schema_version: 2, teams: vec![], skills: legacy_catalog(), chats: vec![] };
        store.skills.push(old.clone());
        upgrade(&mut store);
        assert!(store.skills.iter().any(|s| s.id == "frontend" && s.version == 3));
        assert_eq!(store.skills.iter().find(|s| s.id == "frontend" && s.version == 2).unwrap().instructions, old.instructions);
        old.instructions.push_str("\nCustom instruction");
        assert!(!previous_bundled(&old));
        store.skills = vec![old];
        upgrade(&mut store);
        assert!(!store.skills.iter().any(|s| s.id == "frontend" && s.version == 3));
    }

    #[test]
    fn curated_skills_are_opt_in_and_can_be_selected_by_real_staffing() {
        let skills = catalog();
        let mut team = super::super::domain::tests::team();
        team.autonomous = true;
        let proposal: Vec<AgentProposal> = serde_json::from_value(serde_json::json!([
            {"id":"debugger", "role":"Backend", "skillIds":["superpowers-systematic-debugging", "superpowers-verification-before-completion"]}
        ])).unwrap();
        let expanded = super::super::staffing::with_agents(&team, &proposal, &skills).unwrap();
        let debugger = &expanded.members[1];
        for id in ["superpowers-systematic-debugging", "superpowers-verification-before-completion"] {
            assert!(debugger.skill_refs.iter().any(|r| r.id == id && r.version == 1));
            assert!(!expanded.members[0].skill_refs.iter().any(|r| r.id == id));
        }
        let run: Run = serde_json::from_value(serde_json::json!({
            "id":"selected", "goal":"Investigate", "team":expanded, "skills":skills,
            "status":"planning", "startedAt":1, "tasks":[], "summary":"", "evidenceDir":"unused",
            "artifacts":[], "baseline":[], "notified":false
        })).unwrap();
        let prompt = super::super::runner::skills_prompt(&run, debugger);
        assert!(prompt.contains("Systematic Debugging"));
        assert!(prompt.contains("Verification Before Completion"));
        assert!(prompt.contains("22f0b463e7a5e579904dd6211a520321035526f7"));
    }

    #[test]
    fn curated_catalog_exposes_all_nine_adaptations() {
        let skills = catalog();
        assert_eq!(skills.len(), 22);
        for id in [
            "superpowers-systematic-debugging",
            "superpowers-verification-before-completion",
            "superpowers-requesting-code-review",
            "superpowers-receiving-code-review",
            "superpowers-test-driven-development",
            "superpowers-writing-plans",
            "superpowers-executing-plans",
            "superpowers-writing-skills",
            "superpowers-brainstorming",
        ] {
            let skill = skills.iter().find(|skill| skill.id == id).unwrap_or_else(|| panic!("missing {id}"));
            assert_eq!(skill.version, 1);
            assert!(!skill.instructions.trim().is_empty());
        }
        let mut ids: Vec<&str> = skills.iter().map(|skill| skill.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 22, "catalog must not contain duplicates");
    }

    #[test]
    fn curated_upgrade_preserves_personalized_versions_and_selections() {
        let mut skills = catalog();
        let customized = skills.iter_mut().find(|s| s.id == "superpowers-systematic-debugging").unwrap();
        customized.instructions = "Personalized investigation".into();
        let mut team = super::super::domain::tests::team();
        team.members[0].skill_refs = vec![SkillRef { id: customized.id.clone(), version: 1 }];
        let original_team = serde_json::to_value(&team).unwrap();
        let mut store = Store { fallback_models: vec![], schema_version: 3, teams: vec![team], skills, chats: vec![] };
        let original_skills = serde_json::to_value(&store.skills).unwrap();
        upgrade(&mut store);
        upgrade(&mut store);
        assert_eq!(serde_json::to_value(&store.skills).unwrap(), original_skills);
        assert_eq!(serde_json::to_value(&store.teams[0]).unwrap(), original_team);
    }
}
